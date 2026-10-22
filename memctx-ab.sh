#!/bin/bash
# Live A/B: v2 memory-context projection (issue #202 step 2).
# Arm A = projection OFF (baseline), arm B = projection ON (variant).
# Same prompt, same model, same fixture, separate sessions.
set -u
BIN=/private/var/folders/1m/v4ljzvzx5x566w1r067w5vmw0000gn/T/opencode/wt-v2/packages/cli/dist/cli-darwin-arm64/bin/opencode
DB="$HOME/.local/share/opencode/opencode.db"
LOGDIR="$HOME/.local/share/opencode/log"
MODEL="${MEMCTX_MODEL:-ladder/standard}"
STAMP=$(date +%H%M%S)
OUT=/tmp/memctx-ab-$STAMP
mkdir -p "$OUT"
FIX=$(mktemp -d)
python3 - "$FIX" <<'PY'
import sys
d = sys.argv[1]
lines = ['big-output-line-%d %s' % (i, 'x' * 60) for i in range(3000)]
open(d + '/big.txt', 'w').write('\n'.join(lines))
PY
BIG="$FIX/big.txt"
SESSIONS="$OUT/sessions.txt"

# turn 1: the tool call that puts the big output into the context
P1="Вызови shell-тул с командой 'cat $BIG' и кратко сообщи: сколько примерно строк в выводе и есть ли в нём маркер ужатия (строка вида '[showing ... of ...]'). Больше ничего не делай."
# turn 2: the needle must still be reachable — compression may not hide anything
P2="Теперь найди в полном выводе того tool-а строку 'big-output-line-2999' (файл с полным выводом указан в маркере; используй grep, read или get_tool_call_details) и приведи её целиком."

arm() {
  local name="$1" mode="$2"
  local ses="ses_memctx-${name}-${STAMP}"
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

# fresh debug log for this run
: > "$LOGDIR/memory-context.log" 2>/dev/null

arm baseline baseline
arm variant variant

echo "=== MEM-CONTEXT DEBUG LOG (projection trace) ==="
cat "$LOGDIR/memory-context.log" 2>/dev/null | tail -20

echo "=== METRICS ==="
while read -r ses; do
  echo "--- session $ses ---"
  sqlite3 "$DB" "
    select seq, type,
      json_extract(data,'\$.tokens.input') as input,
      json_extract(data,'\$.tokens.output') as output,
      json_extract(data,'\$.tokens.cache.read') as cache_read,
      json_extract(data,'\$.tokens.reasoning') as reasoning
    from session_message where session_id='$ses' and type='assistant' order by seq;" 2>/dev/null
  echo "-- provider-visible total (input+cache_read) per assistant turn --"
  sqlite3 "$DB" "
    select seq, coalesce(json_extract(data,'\$.tokens.input'),0) + coalesce(json_extract(data,'\$.tokens.cache.read'),0) + coalesce(json_extract(data,'\$.tokens.cache.write'),0) as visible
    from session_message where session_id='$ses' and type='assistant' order by seq;" 2>/dev/null
  echo "-- tool calls by name --"
  sqlite3 "$DB" "
    select json_extract(p.value,'\$.name') as tool, count(*)
    from session_message m, json_each(m.data,'\$.content') p
    where m.session_id='$ses' and json_extract(p.value,'\$.type')='tool'
    group by 1;" 2>/dev/null
  echo "-- needle present in session (0/1) --"
  sqlite3 "$DB" "select count(*) from session_message where session_id='$ses' and data like '%big-output-line-2999%';" 2>/dev/null
  echo "-- needle in the final assistant answer --"
  sqlite3 "$DB" "select count(*) from session_message where session_id='$ses' and type='assistant' and data like '%big-output-line-2999%';" 2>/dev/null
done < "$SESSIONS"
echo "OUT=$OUT"
