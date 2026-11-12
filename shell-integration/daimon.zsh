# daimon shell integration
# Source this from your ~/.zshrc:
#   source ~/.config/daimon/daimon.zsh

DAIMON_BIN="${DAIMON_BIN:-daimon}"

# Load user opt-in modules (written by `daimon setup`)
[[ -f "$HOME/.config/daimon/config.zsh" ]] && source "$HOME/.config/daimon/config.zsh"

_daimon_precmd() {
  local code=$?
  DAIMON_EXIT_CODE=$code "$DAIMON_BIN" precmd
}

_daimon_preexec() {
  "$DAIMON_BIN" preexec
}

precmd_functions+=(_daimon_precmd)
preexec_functions+=(_daimon_preexec)

# Minimal prompt — daimon renders its own chrome
PROMPT=' '
RPROMPT=''
unsetopt PROMPT_CR PROMPT_SP 2>/dev/null || true
