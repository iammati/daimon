# daimon shell integration — loaded via ZDOTDIR override

# Source the real user zshrc first
[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"

# Disable right-prompt and set minimal left-prompt — daimon renders its own UI chrome
RPROMPT=''
RPS1=''
PROMPT=' '
unsetopt PROMPT_CR PROMPT_SP 2>/dev/null || true

# OSC 133 prompt hooks — daimon uses these for command boundary detection
_daimon_precmd() {
  local code=$?

  # git info — fast, porcelain
  local git_branch="" git_dirty=false git_ahead=0 git_behind=0
  if git_branch=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null); then
    local git_status
    git_status=$(git status --porcelain -b 2>/dev/null)
    [[ -n "$(echo "$git_status" | tail -n +2)" ]] && git_dirty=true
    git_ahead=$(echo "$git_status" | grep -o 'ahead [0-9]*' | grep -o '[0-9]*' || echo 0)
    git_behind=$(echo "$git_status" | grep -o 'behind [0-9]*' | grep -o '[0-9]*' || echo 0)
    git_ahead=${git_ahead:-0}
    git_behind=${git_behind:-0}
  fi

  # OpenStack / ccloud context
  local os_region="${OS_REGION_NAME:-}"
  local os_project="${OS_PROJECT_NAME:-}"
  local os_domain="${OS_PROJECT_DOMAIN_NAME:-}"
  local ccloud_prompt="${CCLOUD_PROMPT_NOCOLOR:-${CCLOUD_PROMPT:-}}"

  # Kubernetes context
  local k8s_ctx="${KUBECTL_CONTEXT:-}"
  local k8s_ns="${KUBECTL_NAMESPACE:-}"
  # Fallback: read from kubectl if env not set but KUBECONFIG is
  if [[ -z "$k8s_ctx" && -n "$KUBECONFIG" ]]; then
    k8s_ctx=$(kubectl config current-context 2>/dev/null || echo "")
    k8s_ns=$(kubectl config view --minify --output 'jsonpath={..namespace}' 2>/dev/null || echo "")
  fi

  # Build JSON — manual concat to avoid jq dependency
  local json="{"
  json+="\"pwd\":\"${PWD}\","
  json+="\"exitCode\":${code},"
  [[ -n "$git_branch" ]]    && json+="\"gitBranch\":\"${git_branch}\","
  json+="\"gitDirty\":${git_dirty},"
  json+="\"gitAhead\":${git_ahead:-0},"
  json+="\"gitBehind\":${git_behind:-0},"
  [[ -n "$os_region" ]]     && json+="\"region\":\"${os_region}\","
  [[ -n "$os_project" ]]    && json+="\"project\":\"${os_project}\","
  [[ -n "$os_domain" ]]     && json+="\"domain\":\"${os_domain}\","
  [[ -n "$ccloud_prompt" ]] && json+="\"ccloudPrompt\":\"${ccloud_prompt}\","
  [[ -n "$k8s_ctx" ]]       && json+="\"k8sContext\":\"${k8s_ctx}\","
  [[ -n "$k8s_ns" ]]        && json+="\"k8sNamespace\":\"${k8s_ns}\","
  json="${json%,}}"  # strip trailing comma

  printf $'\e]133;A%s\e\\' "$json"
}

_daimon_preexec() {
  printf $'\e]133;C\e\\'
}

precmd_functions+=(_daimon_precmd)
preexec_functions+=(_daimon_preexec)
