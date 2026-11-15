# daimon remote warpify payload — sourced into a remote zsh over SSH.
# Pure zsh, no binary: emits the same OSC 133 markers daimon's local integration emits,
# so the daemon parses remote command boundaries exactly like local ones.
# Git info via `git` subprocess (libgit2 unavailable remotely); silent when git absent.

_daimon_remote_precmd() {
  local code=$?
  local pwd="${PWD}"
  local branch="" dirty=false
  if command git rev-parse --is-inside-work-tree &>/dev/null; then
    branch=$(command git symbolic-ref --short HEAD 2>/dev/null || command git rev-parse --short HEAD 2>/dev/null)
    command git diff --quiet &>/dev/null && command git diff --cached --quiet &>/dev/null || dirty=true
  fi
  # Hand-built JSON (no jq); escape backslash then double-quote in pwd.
  local esc="${pwd//\\/\\\\}"; esc="${esc//\"/\\\"}"
  local json="{\"pwd\":\"${esc}\",\"exitCode\":${code}"
  if [[ -n "$branch" ]]; then
    local besc="${branch//\\/\\\\}"; besc="${besc//\"/\\\"}"
    json+=",\"gitBranch\":\"${besc}\",\"gitDirty\":${dirty}"
  fi
  json+="}"
  printf '\e]133;A%s\e\\' "$json"
}

_daimon_remote_preexec() { printf '\e]133;C\e\\'; }

precmd_functions+=(_daimon_remote_precmd)
preexec_functions+=(_daimon_remote_preexec)

# Minimal prompt — daimon renders its own chrome.
PROMPT=' '
RPROMPT=''
unsetopt PROMPT_CR PROMPT_SP 2>/dev/null || true
