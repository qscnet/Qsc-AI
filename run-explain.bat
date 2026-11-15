@echo off
cd /d "%~dp0"

echo [1/4] outliers: chapters wrongly flagged as AI ...
node explain.js --preset outliers --top 10 > out-explain.txt 2>&1

echo [2/4] human-ok: a normal human chapter ...
node explain.js --preset human-ok --top 10 > out-explain-ok.txt 2>&1

echo [3/4] ai-book: the de-AI-ed chapter ...
node explain.js --preset ai-book --top 10 > out-explain-ai.txt 2>&1

echo [4/4] scan the whole de-AI-ed book ...
node explain.js --preset ai-dir --summary > out-scan.txt 2>&1

echo.
echo DONE - out-explain.txt / out-explain-ok.txt / out-explain-ai.txt / out-scan.txt
pause
