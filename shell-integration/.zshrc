# daimon shell integration entry point — loaded by zsh when ZDOTDIR points here.
# Source the user's real ~/.zshrc first, then overlay daimon hooks.
_daimon_zdotdir="${ZDOTDIR}"
ZDOTDIR="$HOME"
[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"
source "${_daimon_zdotdir}/daimon.zsh"
unset _daimon_zdotdir
