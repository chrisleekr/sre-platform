#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
project_root=${1:-.}
cd "$project_root"

root=packages/connectors/src/data-sources
inbound_root=packages/connectors/src/inbound
max_production_lines=500
min_module_lines=25
max_test_lines=600
failed=0
provider_roots=("$root")

bun "$script_dir/check-connector-catalogs.mjs" "$PWD"

for provider in "$root"/*; do
  [[ -d "$provider" ]] || continue
  if [[ ! -f "$provider/index.ts" ]]; then
    printf 'Connector provider is missing index.ts: %s\n' "$provider" >&2
    failed=1
  fi
done

for provider in "$inbound_root"/*; do
  [[ -d "$provider" ]] || continue
  [[ $(basename "$provider") == '__tests__' ]] && continue
  provider_roots+=("$provider")
  if [[ ! -f "$provider/index.ts" ]]; then
    printf 'Inbound connector provider is missing index.ts: %s\n' "$provider" >&2
    failed=1
  fi
done

if [[ ! -f "$inbound_root/catalog.ts" ]]; then
  printf 'Inbound connector catalog is missing: %s\n' "$inbound_root/catalog.ts" >&2
  failed=1
fi

while IFS= read -r file; do
  lines=$(wc -l < "$file" | tr -d ' ')
  name=$(basename "$file")
  if (( lines > max_production_lines )); then
    printf 'Connector module exceeds %d lines (%d): %s\n' \
      "$max_production_lines" "$lines" "$file" >&2
    failed=1
  fi
  case "$name" in
    index.ts|types.ts|definition.ts) continue ;;
  esac
  if (( lines < min_module_lines )); then
    printf 'Connector module is too fragmented, minimum %d lines (%d): %s\n' \
      "$min_module_lines" "$lines" "$file" >&2
    failed=1
  fi
done < <(find "${provider_roots[@]}" -type f -name '*.ts' ! -path '*/__tests__/*' | sort)

while IFS= read -r file; do
  lines=$(wc -l < "$file" | tr -d ' ')
  if (( lines > max_test_lines )); then
    printf 'Connector test module exceeds %d lines (%d): %s\n' \
      "$max_test_lines" "$lines" "$file" >&2
    failed=1
  fi
done < <(find "${provider_roots[@]}" -type f -path '*/__tests__/*.ts' | sort)

legacy=$(find packages/connectors/src -maxdepth 1 -type f \( \
  -name 'argocd*.ts' -o -name 'aws.ts' -o -name 'datadog.ts' -o \
  -name 'github*.ts' -o -name 'gitlab*.ts' -o -name 'grafana.ts' -o \
  -name 'kubernetes*.ts' -o -name 'networkprobe.ts' -o \
  -name 'prometheus*.ts' -o -name 'statuscake.ts' \
\) -print)
if [[ -n "$legacy" ]]; then
  printf 'Connector providers must live under data-sources/<provider>:\n%s\n' "$legacy" >&2
  failed=1
fi
while IFS= read -r file; do
  case $(basename "$file") in
    catalog.ts|fake.ts|registry-default.ts|registry.ts|types.ts) continue ;;
  esac
  printf 'Inbound providers must live under inbound/<provider>: %s\n' "$file" >&2
  failed=1
done < <(find "$inbound_root" -maxdepth 1 -type f -name '*.ts' | sort)

exit "$failed"
