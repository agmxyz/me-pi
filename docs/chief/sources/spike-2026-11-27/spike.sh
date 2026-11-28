#!/bin/bash
# Spike: pi print-mode session reuse, concurrent runs on one session id, background delegate at exit.
O=/tmp/chief-spike/out; cd /tmp/chief-spike/repo
export ME_PI_UNATTENDED=1
ID=chief-spike-a-$$
echo "1" > $O/progress
pi -p --mode json --session-id $ID "Remember the word PELICAN. Reply with only: ok" > $O/s1-run1.jsonl 2> $O/s1-run1.err; echo "run1 exit $?" > $O/s1.txt
pi -p --mode json --session-id $ID "What word did I ask you to remember? Reply with only the word." > $O/s1-run2.jsonl 2> $O/s1-run2.err; echo "run2 exit $?" >> $O/s1.txt
pi -p --session $ID "Reply with only the remembered word again." > $O/s1-run3.txt 2> $O/s1-run3.err; echo "run3(--session) exit $?" >> $O/s1.txt
find ~/.pi/agent/sessions -name "*$ID*" >> $O/s1.txt
echo "2" >> $O/progress
ID2=chief-spike-b-$$
pi -p --mode json --session-id $ID2 "Reply with only: base" > $O/s2-base.jsonl 2>&1
pi -p --mode json --session-id $ID2 "Run the bash command 'sleep 8; echo A-done' then reply with only: A" > $O/s2-a.jsonl 2> $O/s2-a.err & PA=$!
sleep 2
pi -p --mode json --session-id $ID2 "Run the bash command 'sleep 8; echo B-done' then reply with only: B" > $O/s2-b.jsonl 2> $O/s2-b.err & PB=$!
wait $PA; echo "A exit $?" > $O/s2.txt; wait $PB; echo "B exit $?" >> $O/s2.txt
F=$(find ~/.pi/agent/sessions -name "*$ID2*" | head -1); echo "file $F" >> $O/s2.txt; cp "$F" $O/s2-session.jsonl 2>/dev/null
pi -p --session-id $ID2 "List, in order, every reply you gave earlier in this conversation, one per line, nothing else." > $O/s2-after.txt 2> $O/s2-after.err; echo "after exit $?" >> $O/s2.txt
echo "3" >> $O/progress
ID3=chief-spike-c-$$
pi -p --mode json --session-id $ID3 "Call the delegate tool once with role scout, background true, and task: 'Read /tmp/chief-spike/repo and list its files, then wait: read the same directory 5 more times.' Then immediately reply with only the job id. Do not wait for the job." > $O/s3-run1.jsonl 2> $O/s3-run1.err; echo "run1 exit $?" > $O/s3.txt
sleep 5; ps -Ao pid,lstart,command | grep -E "ME_PI|pi .*--mode|delegate" | grep -v grep | head -5 >> $O/s3.txt
pi -p --session-id $ID3 "Did a delegate job result arrive in this conversation? Quote any delegate message you can see, or say NONE." > $O/s3-run2.txt 2> $O/s3-run2.err; echo "run2 exit $?" >> $O/s3.txt
echo "done" >> $O/progress
