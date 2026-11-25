#!/usr/bin/env python3
"""Собирает страницу мини-приложения из src/app.html и catalog.json.

  python3 build.py                 -> index.html (её отдаёт GitHub Pages, работает с сервером клуба)
  python3 build.py --demo FILE     -> страница без сервера и без обёртки, для показа как демо
"""
import json, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
API = os.environ.get("FH_API", "https://fullhouse-bot.the-last-city.workers.dev")
OUT = os.environ.get("FH_OUT", os.path.join(ROOT, "index.html"))

src = open(os.path.join(ROOT, "src", "app.html"), encoding="utf-8").read()
catalog = json.load(open(os.path.join(ROOT, "catalog.json"), encoding="utf-8"))


def fill(page, api):
    for mark, value in (("/*__CATALOG__*/null", json.dumps(catalog, ensure_ascii=False, separators=(",", ":"))),
                        ("/*__API__*/''", json.dumps(api))):
        assert page.count(mark) == 1, mark
        page = page.replace(mark, value)
    return page


if len(sys.argv) == 3 and sys.argv[1] == "--demo":
    open(sys.argv[2], "w", encoding="utf-8").write(fill(src, ""))
    print("demo:", sys.argv[2])
    sys.exit(0)

page = fill(src, API)
cut = page.index("<canvas")
head, body = page[:cut], page[cut:]
head = head.replace('<meta name="claude:viewport-fit-sides" content="cover">', "").strip()

doc = f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<meta name="theme-color" content="#06050a">
<meta name="robots" content="noindex">
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>:root{{color-scheme:dark;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}body{{margin:0}}img{{max-width:100%}}[hidden]{{display:none!important}}</style>
{head}
</head>
<body>
{body.strip()}
</body>
</html>
"""
open(OUT, "w", encoding="utf-8").write(doc)
if OUT.endswith("index.html") and os.path.dirname(OUT) == ROOT:
    open(os.path.join(ROOT, ".nojekyll"), "w").close()
print(os.path.basename(OUT) + ":", len(doc), "bytes, API:", API)
