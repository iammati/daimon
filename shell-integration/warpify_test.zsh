#!/usr/bin/env zsh
# Self-check for warpify.zsh: the remote payload must emit OSC 133 markers the daimon
# daemon's parser accepts (crates/shell-parser is_prompt_marker / is_command_start_marker,
# extract_context_json). Run: zsh shell-integration/warpify_test.zsh
set -e
here=${0:A:h}
source "$here/warpify.zsh"

a=$(_daimon_remote_precmd)
[[ "$a" == $'\e]133;A'*$'\e\\' ]] || { print "FAIL: precmd not wrapped in OSC 133;A...ST"; exit 1 }
json=${a#$'\e]133;A'}; json=${json%$'\e\\'}
print -r -- "$json" | python3 -I -c 'import sys,json; d=json.load(sys.stdin); assert "pwd" in d and "exitCode" in d, d' \
  || { print "FAIL: precmd JSON invalid or missing keys"; exit 1 }

c=$(_daimon_remote_preexec)
[[ "$c" == $'\e]133;C\e\\' ]] || { print "FAIL: preexec marker wrong"; exit 1 }

print "ok: warpify payload emits valid OSC 133 markers"
