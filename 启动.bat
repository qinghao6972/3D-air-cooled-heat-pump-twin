@echo off
rem ============================================================
rem  ASCII-only launcher.
rem  DO NOT put any non-ASCII text in this file: cmd.exe seeks the
rem  batch file by BYTE offset, and a UTF-8 Chinese character is 3
rem  bytes while cmd (codepage 936) expects 2, so the parser lands
rem  in the middle of a line and the script falls apart.
rem  All localized messages live in start.ps1 (UTF-8 with BOM).
rem ============================================================
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 pause
