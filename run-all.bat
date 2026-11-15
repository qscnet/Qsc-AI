@echo off
cd /d "%~dp0"
echo run-all started %date% %time% > last-run.txt

echo [1/5] bootstrap: append ...
node bootstrap.js > out-1-bootstrap.txt 2>&1
echo [2/5] calibrate ...
node calibrate.js > out-2-calibrate.txt 2>&1
echo [3/5] recheck ...
node bootstrap.js --dry > out-3-recheck.txt 2>&1
echo [4/5] diagnose ...
node diagnose.js > out-4-diagnose.txt 2>&1
echo [5/5] train ...
set PYEXE=C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe
python train.py > out-5-train.txt 2>&1
if errorlevel 1 "%PYEXE%" train.py > out-5-train.txt 2>&1

echo DONE >> last-run.txt
echo.
echo ALL DONE - files out-1..out-5
pause
