#!/bin/bash
# Live A/B, second fixture: a big file read through the read tool.
# The read tool keeps up to MAX_READ_BYTES (50 KiB) in the context, so the
# baseline context carries the whole file while the projection replaces it
# with a ~1 KB marker.
set -u
BIN=/private/var/folders/1m/v4ljzvzx5x566w1r067w5vmw0000gn/T/opencode/wt-v2/packages/cli/dist/cli-darwin-arm64/bin/opencode
DB="$HOME/.local/share/opencode/opencode.db"
LOGDIR="$HOME/.local/share/opencode/log"
MODEL="${MEMCTX_MODEL:-ladder/standard}"
STAMP=$(date +%H%M%S)
OUT=/tmp/memctx-read-$STAMP
mkdir -p "$OUT"
FIX=$(mktemp -d)
python3 - "$FIX" <<'PY'
import sys
d = sys.argv[1]
lines = ['read-line-%d %s' % (i, 'y' * 60) for i in range(1000)]
open(d + '/doc.txt', 'w').write('\n'.join(lines))
PY
DOC="$FIX/doc.txt"
SESSIONS="$OUT/sessions.txt"

P1="Прочитай файл $DOC через read-тул и ответь одним предложением: сколько примерно строк в файле и как выглядит первая строка?"
P2="Теперь ответь одним предложением: какой маркер (или текст) остался от вывода read-тула в твоём контексте? Ничего больше не делай."

arm() {
  local name="$1" mode="$2"
  local ses="ses_memctx-read-${name}-${STAMP}"
  echo "$ses" >> "$SESSIONS"
  echo "=== ARM $name (mode=$mode) session=$ses ==="
  if [ "$mode" = "variant" ]; then
    OPENCODE_V2_MEMORY_CONTEXT=1 OPENCODE_V2_MEMORY_CONTEXT_DEBUG=1 "$BIN" run --standalone --model "$MODEL" --auto --session "$ses" "$P1" > "$OUT/$name-T1.log" 2>&1
    echo "T1 exit=$?"
    OPENCODE_V2_MEMORY_CONTEXT=1 OPENCODE_V2_MEMORY_CONTEXT_DEBUG=1 "$BIN" run --standalone --model "$MODEL" --auto --session "$ses" "$P2" > "$OUT/$name-T2.log" 2>&1
    echo "T2 exit=$?"
  else
    env -u OPENCODE_V2_MEMORY_CONTEXT -u OPENCODE_V2_MEMORY_CONTEXT_DEBUG "$BIN" run --standalone --model "$MODEL" --auto --session "$ses" "$P1" > "$OUT/$name-T1.log" 2>&1
    echo "T1 exit=$?"
    env -u OPENCODE_V2_MEMORY_CONTEXT -u OPENCODE_V2_MEMORY_CONTEXT_DEBUG "$BIN" run --standalone --model "$MODEL" --auto --session "$ses" "$P2" > "$OUT/$name-T2.log" 2>&1
    echo "T2 exit=$?"
  fi
}

: > "$LOGDIR/memory-context.log" 2>/dev/null

arm baseline baseline
arm variant variant

echo "=== MEM-CONTEXT DEBUG LOG ==="
tail -10 "$LOGDIR/memory-context.log" 2>/dev/null

echo "=== METRICS ==="
while read -r ses; do
  echo "--- session $ses ---"
  sqlite3 "$DB" "
    select seq,
      coalesce(json_extract(data,'\$.tokens.input'),0) as input,
      coalesce(json_extract(data,'\$.tokens.cache.read'),0) as cache_read,
      coalesce(json_extract(data,'\$.tokens.input'),0)+coalesce(json_extract(data,'\$.tokens.cache.read'),0)+coalesce(json_extract(data,'\$.tokens.cache.write'),0) as visible,
      length(data) as msg_bytes
    from session_message where session_id='$ses' and type='assistant' order by seq;" 2>/dev/null
  echo "-- tool calls --"
  sqlite3 "$DB" "
    select json_extract(p.value,'\$.name') as tool, count(*)
    from session_message m, json_each(m.data,'\$.content') p
    where m.session_id='$ses' and json_extract(p.value,'\$.type')='tool'
    group by 1;" 2>/dev/null
done < "$SESSIONS"
echo "OUT=$OUT"
