#!/bin/bash
# 双击启动「判一句」
# 本地开 http://127.0.0.1:5199

cd "$(dirname "$0")" || exit 1

if curl -s --max-time 1 http://127.0.0.1:5199/ >/dev/null 2>&1; then
  open "http://127.0.0.1:5199"
  exit 0
fi

echo "启动中…"
python3 -m http.server 5199 --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER_PID=$!

for i in $(seq 1 16); do
  if curl -s --max-time 1 http://127.0.0.1:5199/ >/dev/null 2>&1; then
    open "http://127.0.0.1:5199"
    break
  fi
  sleep 0.3
done

echo ""
echo "服务在跑。关掉这个窗口就停。"
echo "手机访问：http://$(ipconfig getifaddr en0 2>/dev/null || echo '本机IP'):5199"
wait $SERVER_PID
