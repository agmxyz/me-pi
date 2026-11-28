#!/bin/bash
O=/tmp/chief-spike2/out; R=/tmp/chief-spike2/repo; cd $R
export ME_PI_UNATTENDED=1
last() { tail -n 3 "$1" | cut -c1-160; }
stop() { python3 -I -c "
import json,sys
r=[]
for l in open(sys.argv[1]):
    try: e=json.loads(l)
    except Exception: continue
    m=e.get('message') or {}
    if e.get('type') in('message_end','turn_end','agent_end','agent_settled') : r.append((e.get('type'), m.get('stopReason'), e.get('aborted')))
print(r[-4:])" "$1"; }
# E1a SIGTERM mid-tool
ID=sp2-term-$$
pi -p --mode json --session-id $ID "Run the bash command 'sleep 60; echo SLEPT > /tmp/chief-spike2/out/e1a-marker' and then reply done." > $O/e1a.jsonl 2> $O/e1a.err & P=$!
sleep 14; pgrep -f "sleep 60" > $O/e1a-children-before.txt; kill -TERM $P; wait $P; echo "E1a SIGTERM exit=$?" > $O/e1.txt
sleep 2; echo "sleep children alive after TERM: $(pgrep -f 'sleep 60' | wc -l | tr -d ' ')" >> $O/e1.txt; stop $O/e1a.jsonl >> $O/e1.txt; last $O/e1a.jsonl >> $O/e1.txt; pkill -f "sleep 60"
# E1b SIGKILL mid-tool
ID=sp2-kill-$$
pi -p --mode json --session-id $ID "Run the bash command 'sleep 61; echo SLEPT' and then reply done." > $O/e1b.jsonl 2> $O/e1b.err & P=$!
sleep 14; kill -KILL $P; wait $P 2>/dev/null; echo "E1b SIGKILL exit=$?" >> $O/e1.txt
sleep 2; echo "sleep children alive after KILL: $(pgrep -f 'sleep 61' | wc -l | tr -d ' ')" >> $O/e1.txt; stop $O/e1b.jsonl >> $O/e1.txt; pkill -f "sleep 61"
pi -p --session-id $ID "What was the last thing you did in this conversation and did it finish? One line." > $O/e1b-resume.txt 2> $O/e1b-resume.err; echo "E1b resume exit=$?" >> $O/e1.txt
# E1c failing invocation: unknown model
pi -p --mode json --no-session --model no-such-model-xyz "hi" > $O/e1c.jsonl 2> $O/e1c.err; echo "E1c bad model exit=$?" >> $O/e1.txt
echo 1 > $O/progress
# E2 trust: untrusted /tmp repo with project skill
Q="List the exact names of all skills available to you, comma separated, nothing else."
pi -p --no-session "$Q" > $O/e2-default.txt 2> $O/e2-default.err; echo "default exit=$?" > $O/e2.txt
pi -p --no-session --approve "$Q" > $O/e2-approve.txt 2> $O/e2-approve.err; echo "approve exit=$?" >> $O/e2.txt
( cd "${WORKTREE:?set WORKTREE to a test worktree}" && pi -p --no-session --tools read "$Q" > $O/e2-worktree.txt 2> $O/e2-worktree.err; echo "worktree exit=$?" >> $O/e2.txt )
echo 2 >> $O/progress
# E3 foreground delegate in print mode
pi -p --mode json --no-session "Call the delegate tool once with role scout and task 'Read /tmp/chief-spike2/repo/file.txt and report its content.' (not background). Then reply with exactly what the worker reported." > $O/e3.jsonl 2> $O/e3.err; echo "E3 exit=$?" > $O/e3.txt; stop $O/e3.jsonl >> $O/e3.txt
python3 -I -c "
import json
for l in open('$O/e3.jsonl'):
    try: e=json.loads(l)
    except Exception: continue
    if e.get('type')=='tool_execution_end': print('tool', e.get('toolName'), 'isError', e.get('isError'), str(e.get('result'))[:300])
    if e.get('type')=='agent_end':
        m=e.get('messages',[])[-1]; print('final', str(m.get('content'))[:300])
" >> $O/e3.txt 2>&1
echo 3 >> $O/progress
# E4 guard in unattended print mode
pi -p --mode json --no-session "Run exactly this bash command once: git reset --hard HEAD . Then reply with the exact tool result text." > $O/e4.jsonl 2> $O/e4.err; echo "E4 exit=$?" > $O/e4.txt; grep -o 'Blocked ([^"]*' $O/e4.jsonl | head -2 >> $O/e4.txt
echo 4 >> $O/progress
# E5 interactive open of a headless session under a pty
ID=sp2-tui-$$
pi -p --session-id $ID "Remember the word HERON. Reply with only: ok" > /dev/null 2>&1
python3 -I - "$ID" > $O/e5.txt 2>&1 <<'PY'
import os,pty,sys,time,select,signal,re
pid,fd=pty.fork()
if pid==0:
    os.environ['TERM']='xterm-256color'; os.environ.pop('ME_PI_UNATTENDED',None)
    os.execvp('pi',['pi','--session',sys.argv[1]])
buf=b''; t=time.time()
while time.time()-t<12:
    r,_,_=select.select([fd],[],[],0.5)
    if r:
        try: buf+=os.read(fd,65536)
        except OSError: break
os.kill(pid,signal.SIGTERM); time.sleep(1)
try: os.kill(pid,signal.SIGKILL)
except Exception: pass
txt=re.sub(rb'\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07',b'',buf).decode('utf8','replace')
print('bytes',len(buf),'HERON on screen:', 'HERON' in txt, '| "ok" reply shown:', 'ok' in txt)
print(' '.join(txt.split())[:500])
PY
echo done >> $O/progress
