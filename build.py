#!/usr/bin/env python3
"""Собирает index.html (то, что отдаёт GitHub Pages) из src/app.html.

Запуск:  python3 build.py
"""
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(ROOT, "src", "app.html"), encoding="utf-8").read()
cut = src.index('<div class="app"')
head, body = src[:cut], src[cut:]
head = head.replace('<meta name="claude:viewport-fit-sides" content="cover">', "").strip()

doc = f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<meta name="theme-color" content="#0a0a0a">
<meta name="robots" content="noindex">
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>:root{{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}body{{margin:0}}img{{max-width:100%}}[hidden]{{display:none!important}}</style>
{head}
</head>
<body>
{body.strip()}
</body>
</html>
"""
open(os.path.join(ROOT, "index.html"), "w", encoding="utf-8").write(doc)
open(os.path.join(ROOT, ".nojekyll"), "w").close()
print("index.html:", len(doc), "bytes")
