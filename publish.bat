@echo off
chcp 65001 >nul
title Aivin CLI - Phat Hanh Phien Ban
cd /d "%~dp0"
node scripts\release-publish.mjs
echo.
pause
