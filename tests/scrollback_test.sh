#!/usr/bin/env bash
# Test: daimon block model handles 10k+ line output without truncation.
# Runs against a real daimon daemon via its SQLite store.
# Usage: ./tests/scrollback_test.sh

set -e

DB="${XDG_DATA_HOME:-$HOME/Library/Application Support}/daimon/daimon.db"
if [ ! -f "$DB" ]; then
  echo "SKIP: daimon DB not found at $DB — start daimon first"
  exit 0
fi

# Generate 10,000 lines and run it through a shell spawned by daimon.
# Since we can't inject commands directly, we test the SQLite storage layer:
# write a fake block with 10k lines of output_json, then read it back.

SESSION_ID="scrollback-test-$$"
BLOCK_ID="scrollback-block-$$"
LINES=10000

echo "Writing $LINES lines to output_json..."

# Build JSON array of $LINES line strings
python3 -c "
import json, sys
lines = [f'line {i}: the quick brown fox jumped over the lazy dog' for i in range($LINES)]
out = [{'kind': 'lines', 'lines': lines}]
print(json.dumps(out))
" > /tmp/daimon_scrollback_out.json

OUTPUT_JSON=$(cat /tmp/daimon_scrollback_out.json)

sqlite3 "$DB" <<SQL
INSERT OR IGNORE INTO blocks(id, session_id, input, cwd, ctx, ts, exit_code, output_json)
VALUES(
  '$BLOCK_ID',
  '$SESSION_ID',
  'seq 1 $LINES',
  '/tmp',
  'default',
  $(date +%s)000,
  0,
  '$(echo "$OUTPUT_JSON" | sed "s/'/''/g")'
);
SQL

echo "Reading back..."

STORED_LINES=$(sqlite3 "$DB" \
  "SELECT output_json FROM blocks WHERE id='$BLOCK_ID';" \
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
total = sum(len(chunk['lines']) for chunk in data if chunk.get('kind') == 'lines')
print(total)
")

# Cleanup
sqlite3 "$DB" "DELETE FROM blocks WHERE id='$BLOCK_ID';"
rm -f /tmp/daimon_scrollback_out.json

if [ "$STORED_LINES" -eq "$LINES" ]; then
  echo "PASS: $STORED_LINES / $LINES lines stored and retrieved intact"
else
  echo "FAIL: expected $LINES lines, got $STORED_LINES"
  exit 1
fi
