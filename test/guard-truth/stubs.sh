#!/bin/bash
# bash-truth stub. Every external command name the corpus uses is a symlink to this file in the run's bin dir.
# It logs its argv as one NUL-separated record (name, cwd, GIT_DIR, GIT_WORK_TREE, STUB_MOVED, argc, args...) to fd 9,
# which bash-truth opens on the row's log (fds survive `env -i`, `exec`, and wrappers), then behaves like the real tool:
# wrappers run the command they wrap, a few data tools (cat, tee, xargs, find, mktemp) do their job, everything
# else (rm, git, node, ssh, watch, ...) only logs. Runs only under bash-truth's sandbox-exec profile.
set +u +f
# BASH_ENV also reached this script: drop the row shims (`test`, `[`, `cd`, path functions) it defined here.
while IFS= read -r f; do unset -f "$f"; done < <(compgen -A function)
me=${0##*/}
bin=${0%/*}
{ printf '%s\0' "$me" "$PWD" "${GIT_DIR-}" "${GIT_WORK_TREE-}" "${STUB_MOVED-}" "$#" "$@" >&9; } 2>/dev/null ||
	echo "STUBLOG-LOST $me" >&2
# A stubbed shell sources the run's bashenv (path functions such as `/bin/rm`, `command`, and `cd` logging) like the
# top one.
bashenv=$bin/../bashenv

# Runs "$@" as the real tool would exec it. A name with a path (`/bin/rm`), or any name once `env -i` emptied PATH
# (execvp then searches /usr/bin:/bin), goes to the stub of that basename; otherwise PATH (the stub dir) finds it.
call() {
	[ $# -gt 0 ] || return 0
	local n=${1##*/}
	if [[ $1 == */* || -z ${PATH:-} ]]; then
		if [ -x "$bin/$n" ]; then
			shift
			"$bin/$n" "$@"
			return
		fi
		echo "stub: no stub for $1" >&2
		return 127
	fi
	"$@"
}
run() {
	call "$@"
	exit $?
}

# parse_opts VALUE_LETTERS "LONG_OPTS_WITH_VALUE" args...: skips getopt-style options. Sets SHIFT (words used) and
# OPTS (" -x --long " for each option seen). Stops at `--` (counted), `-`, or the first operand.
parse_opts() {
	local vl=$1 longs=" $2 " a l j
	shift 2
	SHIFT=0
	OPTS=" "
	while [ $# -gt 0 ]; do
		a=$1
		case $a in
		--)
			SHIFT=$((SHIFT + 1))
			return
			;;
		--*=*)
			OPTS="$OPTS${a%%=*} "
			SHIFT=$((SHIFT + 1))
			shift
			;;
		--*)
			OPTS="$OPTS$a "
			if [[ $longs == *" $a "* ]]; then
				SHIFT=$((SHIFT + 2))
				[ $# -ge 2 ] && shift 2 || shift $#
			else
				SHIFT=$((SHIFT + 1))
				shift
			fi
			;;
		-?*)
			shift
			SHIFT=$((SHIFT + 1))
			j=1
			while [ $j -lt ${#a} ]; do
				l=${a:$j:1}
				OPTS="$OPTS-$l "
				if [ -n "$vl" ] && [[ $vl == *"$l"* ]]; then
					if [ $((j + 1)) -ge ${#a} ]; then
						SHIFT=$((SHIFT + 1))
						[ $# -ge 1 ] && shift
					fi
					break
				fi
				j=$((j + 1))
			done
			;;
		*) return ;;
		esac
	done
}
has() { [[ $OPTS == *" $1 "* ]]; }

# Text from stdin, kept byte-for-byte except NUL.
slurp() {
	local s
	s=$(
		while IFS= read -r l || [ -n "$l" ]; do printf '%s\n' "$l"; done
		printf x
	)
	printf '%s' "${s%x}"
}

case $me in
sudo)
	parse_opts "ughpCDrtUTR" "--user --group --host --prompt --close-from --chdir --role --type --other-user --command-timeout --chroot" "$@"
	shift $SHIFT
	if has -e || has --edit || has -l || has --list || has -v || has --validate || has -K || has -V; then exit 0; fi
	while [ $# -gt 0 ] && [[ $1 == [A-Za-z_]*=* ]]; do
		export "$1"
		shift
	done
	if has -s || has -i || has --shell || has --login; then
		# sudo -s CMD ARGS: the shell runs `-c 'CMD ARGS'` (sudo escapes nothing it hasn't quoted itself).
		[ $# -gt 0 ] || exec env BASH_ENV="$bashenv" /bin/bash
		BASH_ENV=$bashenv exec /bin/bash -c "$*"
	fi
	run "$@"
	;;
doas)
	parse_opts "uCa" "" "$@"
	shift $SHIFT
	has -C && exit 0
	if has -s; then BASH_ENV=$bashenv exec /bin/bash; fi
	run "$@"
	;;
su | runuser)
	# GNU getopt permutes: `-c CMD` may come after the user. A command string runs in the user's shell.
	args=("$@")
	for ((i = 0; i < ${#args[@]}; i++)); do
		a=${args[i]}
		case $a in
		--) break ;;
		-c | --command | --session-command) BASH_ENV=$bashenv exec /bin/bash -c "${args[i + 1]}" ;;
		--command=* | --session-command=*) BASH_ENV=$bashenv exec /bin/bash -c "${a#*=}" ;;
		-[!-]*c*)
			rest=${a#*c}
			[ -n "$rest" ] && BASH_ENV=$bashenv exec /bin/bash -c "$rest"
			BASH_ENV=$bashenv exec /bin/bash -c "${args[i + 1]}"
			;;
		esac
	done
	if [ "$me" = runuser ]; then
		parse_opts "ugGsw" "--user --group --supp-group --shell" "$@"
		shift $SHIFT
		if has -u || has --user; then run "$@"; fi
	fi
	exit 0
	;;
pkexec)
	parse_opts "" "--user" "$@"
	shift $SHIFT
	run "$@"
	;;
env)
	while [ $# -gt 0 ]; do
		case $1 in
		-i | --ignore-environment | -)
			for v in $(compgen -e); do unset "$v" 2>/dev/null; done
			shift
			;;
		-u | --unset)
			unset "$2"
			shift 2
			;;
		-u*)
			unset "${1#-u}"
			shift
			;;
		--unset=*)
			unset "${1#*=}"
			shift
			;;
		-C | --chdir)
			cd "$2" || exit 125
			shift 2
			;;
		--chdir=*)
			cd "${1#*=}" || exit 125
			shift
			;;
		-S | --split-string)
			read -r -a split <<<"$2"
			shift 2
			set -- "${split[@]}" "$@"
			;;
		-S*)
			read -r -a split <<<"${1#-S}"
			shift
			set -- "${split[@]}" "$@"
			;;
		--split-string=*)
			read -r -a split <<<"${1#*=}"
			shift
			set -- "${split[@]}" "$@"
			;;
		-0 | -v | --null | --debug | --default-signal* | --ignore-signal* | --block-signal* | --list-signal-handling) shift ;;
		--)
			shift
			break
			;;
		*) break ;;
		esac
	done
	while [ $# -gt 0 ] && [[ $1 == [A-Za-z_]*=* ]]; do
		export "$1"
		shift
	done
	run "$@"
	;;
timeout | gtimeout)
	parse_opts "sk" "--signal --kill-after" "$@"
	shift $SHIFT
	shift # the duration
	run "$@"
	;;
nice)
	parse_opts "n" "--adjustment" "$@"
	shift $SHIFT
	run "$@"
	;;
nohup | setsid | unbuffer)
	parse_opts "" "" "$@"
	shift $SHIFT
	run "$@"
	;;
time)
	parse_opts "fo" "--format --output" "$@"
	shift $SHIFT
	run "$@"
	;;
stdbuf)
	parse_opts "ioe" "--input --output --error" "$@"
	shift $SHIFT
	run "$@"
	;;
caffeinate)
	parse_opts "tw" "" "$@"
	shift $SHIFT
	run "$@"
	;;
ionice)
	parse_opts "cnpPu" "--class --classdata" "$@"
	shift $SHIFT
	run "$@"
	;;
rtk)
	[ "$1" = proxy ] && shift
	run "$@"
	;;
flock)
	args=("$@")
	for ((i = 0; i < ${#args[@]}; i++)); do
		case ${args[i]} in
		-c | --command) BASH_ENV=$bashenv exec /bin/bash -c "${args[i + 1]}" ;;
		--command=*) BASH_ENV=$bashenv exec /bin/bash -c "${args[i]#*=}" ;;
		esac
	done
	parse_opts "wE" "--timeout --conflict-exit-code" "$@"
	shift $SHIFT
	shift # the lock file
	run "$@"
	;;
sh | bash | zsh | dash | ksh | mksh | ash)
	BASH_ENV=$bashenv exec /bin/bash "$@"
	;;
cat)
	files=()
	for a in "$@"; do
		case $a in -?*) ;; *) files+=("$a") ;; esac
	done
	[ ${#files[@]} -gt 0 ] || files=(-)
	for f in "${files[@]}"; do
		if [ "$f" = - ]; then slurp; else slurp <"$f"; fi
	done
	;;
tee)
	append=
	files=()
	for a in "$@"; do
		case $a in -a | --append) append=1 ;; -?*) ;; *) files+=("$a") ;; esac
	done
	text=$(
		slurp
		printf x
	)
	text=${text%x}
	printf '%s' "$text"
	for f in "${files[@]}"; do
		if [ -n "$append" ]; then printf '%s' "$text" >>"$f"; else printf '%s' "$text" >"$f"; fi
	done
	;;
xargs)
	nul= repl= maxn=
	while [ $# -gt 0 ]; do
		case $1 in
		-0 | --null)
			nul=1
			shift
			;;
		-I)
			repl=$2
			shift 2
			;;
		-I*)
			repl=${1#-I}
			shift
			;;
		-i | --replace)
			repl='{}'
			shift
			;;
		--replace=*)
			repl=${1#*=}
			shift
			;;
		-n)
			maxn=$2
			shift 2
			;;
		-n*)
			maxn=${1#-n}
			shift
			;;
		--max-args=*)
			maxn=${1#*=}
			shift
			;;
		-L | -P | -s | -d | -E | -a | -l | -J | -R | -S) shift 2 ;;
		--*=* | -[LPsdEalJRS]*) shift ;;
		--)
			shift
			break
			;;
		-*) shift ;;
		*) break ;;
		esac
	done
	[ $# -gt 0 ] || set -- echo
	toks=()
	if [ -n "$nul" ]; then
		while IFS= read -r -d '' t; do toks+=("$t"); done
	elif [ -n "$repl" ]; then
		while IFS= read -r t || [ -n "$t" ]; do toks+=("$t"); done
	else
		while read -r -a line || [ ${#line[@]} -gt 0 ]; do
			toks+=("${line[@]}")
			line=()
		done
	fi
	[ ${#toks[@]} -gt 0 ] || exit 0 # BSD xargs: no input, no run
	if [ -n "$repl" ]; then
		for t in "${toks[@]}"; do
			cmd=()
			for a in "$@"; do cmd+=("${a//"$repl"/$t}"); done
			call "${cmd[@]}"
		done
		exit 0
	fi
	n=${maxn:-${#toks[@]}}
	for ((i = 0; i < ${#toks[@]}; i += n)); do call "$@" "${toks[@]:i:n}"; done
	;;
find)
	# Start paths, then each -exec/-execdir/-ok/-okdir command with `{}` replaced by what find would visit:
	# the start path itself and an entry below it.
	starts=()
	while [ $# -gt 0 ]; do
		case $1 in -[HLP]) shift ;; -* | '(' | '!') break ;; *)
			starts+=("$1")
			shift
			;;
		esac
	done
	[ ${#starts[@]} -gt 0 ] || starts=(.)
	found=()
	for s in "${starts[@]}"; do found+=("$s" "${s%/}/found"); done
	while [ $# -gt 0 ]; do
		case $1 in
		-exec | -execdir | -ok | -okdir)
			shift
			cmd=()
			while [ $# -gt 0 ] && [ "$1" != ";" ] && [ "$1" != "+" ]; do
				cmd+=("$1")
				shift
			done
			term=$1
			shift
			if [ "$term" = "+" ]; then
				out=()
				for a in "${cmd[@]}"; do
					if [ "$a" = "{}" ]; then out+=("${found[@]}"); else out+=("$a"); fi
				done
				call "${out[@]}"
			else
				for f in "${found[@]}"; do
					out=()
					for a in "${cmd[@]}"; do out+=("${a//\{\}/$f}"); done
					call "${out[@]}"
				done
			fi
			;;
		*) shift ;;
		esac
	done
	;;
chmod)
	# Real chmod: the sandbox confines it to the row dir, and `chmod +x run.sh && ./run.sh` needs the bit.
	exec /bin/chmod "$@"
	;;
mktemp)
	dir=0 prefix= base=${TMPDIR:-/tmp} template=
	while [ $# -gt 0 ]; do
		case $1 in
		-d | --directory)
			dir=1
			shift
			;;
		-t)
			prefix=$2
			shift 2
			;;
		-p | --tmpdir)
			base=$2
			shift 2
			;;
		--tmpdir=*)
			base=${1#*=}
			shift
			;;
		-q | -u) shift ;;
		*)
			template=$1
			shift
			;;
		esac
	done
	r=$RANDOM$RANDOM
	if [ -n "$template" ]; then
		x=${template%%X*}
		path=$x$r
	elif [ -n "$prefix" ]; then path=$base/$prefix.$r; else path=$base/tmp.$r; fi
	# Never created: writes outside the row dir are denied, and only the name matters here.
	: "$dir"
	printf '%s\n' "$path"
	;;
*)
	# rm, git, ssh, watch, node, python3, ...: log only.
	exit 0
	;;
esac
