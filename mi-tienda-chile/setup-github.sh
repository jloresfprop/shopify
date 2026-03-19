#!/bin/bash
# =====================================================
# Script: Inicializar repo y subir a GitHub
# Uso: bash setup-github.sh <tu-usuario-github>
# =====================================================

GITHUB_USER=${1:-"TU_USUARIO"}
REPO_NAME="shopify-tienda-automatica"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ">>> Inicializando Git en: $REPO_DIR"
cd "$REPO_DIR"

git init
git checkout -b main

git add .
git commit -m "feat: estructura base del tema Shopify - Mi Tienda Chile"

echo ">>> Creando repositorio en GitHub..."
gh repo create "$REPO_NAME" \
  --public \
  --description "Tema Shopify base - Mi Tienda Chile" \
  --source=. \
  --remote=origin \
  --push

echo ""
echo "===== LISTO ====="
echo "Repositorio: https://github.com/$GITHUB_USER/$REPO_NAME"
echo ""
echo "Próximo paso en Shopify Admin:"
echo "  Online Store > Themes > Add theme > Connect from GitHub"
echo "  Selecciona: $GITHUB_USER/$REPO_NAME | rama: main"
