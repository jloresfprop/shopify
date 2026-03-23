@echo off
echo Configurando tarea automatica (cada 5 minutos)...

schtasks /create /tn "ElEstante-AutoSync" /tr "node C:\shopify\scripts\auto-sync.js >> C:\shopify\sync.log 2>&1" /sc minute /mo 5 /f

echo.
echo Tarea creada! El sync corre automatico cada 5 minutos.
echo Puedes verla en: Panel de Control > Programador de Tareas > ElEstante-AutoSync
echo.
echo Para ver los logs: type C:\shopify\sync.log
pause
