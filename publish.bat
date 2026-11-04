@echo off
chcp 65001 >nul
title Aivin CLI - Phat Hanh Phien Ban
cd /d "%~dp0"

node scripts\release-publish.mjs

if errorlevel 1 (
    echo.
    echo ========================================================
    echo   [CHU Y] Phat hanh gap loi. Cua so giu nguyen de xem.
    echo ========================================================
    pause
) else (
    echo.
    echo ========================================================
    echo   [HOAN TAT] Phat hanh thanh cong!
    echo   Cua so se tu dong dong sau 5 giay...
    echo ========================================================
    timeout /t 5
)
