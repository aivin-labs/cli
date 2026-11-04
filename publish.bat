@echo off
chcp 65001 >nul
title Aivin CLI - Ky va Phat hanh

echo ========================================================
echo        AIVIN CLI - QUY TRINH PHAT HANH & DANG TAI
echo ========================================================
echo.

cd /d "%~dp0"

echo [1/4] Kiem tra va tai ban build tu GitHub Releases...
for /f "tokens=2 delims=:, " %%a in ('findstr /i "\"version\"" package.json') do set VERSION=%%~a
set TAG=v%VERSION%
echo Phien ban: %TAG%

if not exist "dist\SHA256SUMS" (
    echo Dang tai ban build tu GitHub Release %TAG%...
    call npm run release:fetch -- %TAG%
    if errorlevel 1 (
        echo [LOI] Khong the tai ban build tu GitHub.
        pause
        exit /b 1
    )
) else (
    echo Ban build trong dist/ da san sang.
)

echo.
echo [2/4] Ky ban phat hanh (SHA256SUMS.sig)...
call npm run sign:release
if errorlevel 1 (
    echo.
    echo [LOI] Ky ban phat hanh that bai (sai mat khau hoac loi khoa).
    pause
    exit /b 1
)

echo.
echo [3/4] Dang ban phat hanh len trang tai get.aivin.vn...
call npm run get:publish
if errorlevel 1 (
    echo.
    echo [LOI] Dang len get.aivin.vn that bai.
    pause
    exit /b 1
)

echo.
echo [4/4] Xuat ban goi len npm registry...
call npm publish
if errorlevel 1 (
    echo.
    echo [CANH BAO] Xuat ban npm that bai.
    echo Neu chua dang nhap npm, hay chay lenh: npm login roi chay lai tep nay.
) else (
    echo [THANH CONG] Da xuat ban @aivin-labs/cli@%VERSION% len npm!
)

echo.
echo ========================================================
echo   HOAN TAT PHAT HANH VA CAP NHAT THANH CONG!
echo ========================================================
echo.
pause
