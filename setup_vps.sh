#!/bin/bash
# ═══════════════════════════════════════════════════════════
# BulletBrain v3.0 — VPS Setup Script (Ubuntu 22.04+)
# Phase D14: Shadow Trading Engine
#
# Usage: chmod +x setup_vps.sh && ./setup_vps.sh
#
# This script:
#   1. Installs Node.js 20.x and PM2
#   2. Creates folder structure
#   3. Installs npm dependencies
#   4. Sets up log directories
#   5. Verifies the environment
# ═══════════════════════════════════════════════════════════

set -e  # Exit on any error

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo ""
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║  BulletBrain v3.0 — VPS Setup (Tokyo)                    ║"
echo "║  Phase D14: Shadow Trading Engine                        ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

# ─────────────────────────────────────────────────────────────
# STEP 1: System Update
# ─────────────────────────────────────────────────────────────
echo -e "${YELLOW}[1/6] Updating system packages...${NC}"
sudo apt-get update -qq && sudo apt-get upgrade -y -qq
echo -e "${GREEN}  ✓ System updated${NC}"

# ─────────────────────────────────────────────────────────────
# STEP 2: Install Node.js 20.x
# ─────────────────────────────────────────────────────────────
echo -e "${YELLOW}[2/6] Installing Node.js 20.x...${NC}"

if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -ge 20 ]; then
        echo -e "${GREEN}  ✓ Node.js $(node -v) already installed${NC}"
    else
        echo "  Upgrading Node.js from $(node -v) to 20.x..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    fi
else
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

echo -e "${GREEN}  ✓ Node.js $(node -v)${NC}"
echo -e "${GREEN}  ✓ npm $(npm -v)${NC}"

# ─────────────────────────────────────────────────────────────
# STEP 3: Install PM2 globally
# ─────────────────────────────────────────────────────────────
echo -e "${YELLOW}[3/6] Installing PM2 process manager...${NC}"

if command -v pm2 &> /dev/null; then
    echo -e "${GREEN}  ✓ PM2 $(pm2 -v) already installed${NC}"
else
    sudo npm install -g pm2
    echo -e "${GREEN}  ✓ PM2 $(pm2 -v) installed${NC}"
fi

# Configure PM2 to start on boot
sudo pm2 startup systemd -u $USER --hp $HOME 2>/dev/null || true
echo -e "${GREEN}  ✓ PM2 startup configured${NC}"

# ─────────────────────────────────────────────────────────────
# STEP 4: Install build tools (for native modules if needed)
# ─────────────────────────────────────────────────────────────
echo -e "${YELLOW}[4/6] Installing build essentials...${NC}"
sudo apt-get install -y -qq build-essential git curl
echo -e "${GREEN}  ✓ Build tools installed${NC}"

# ─────────────────────────────────────────────────────────────
# STEP 5: Project setup
# ─────────────────────────────────────────────────────────────
echo -e "${YELLOW}[5/6] Setting up project...${NC}"

# Create directories
mkdir -p data/historical data/oi data/funding
mkdir -p logs results

echo -e "${GREEN}  ✓ Directory structure created${NC}"

# Install dependencies
echo "  Installing npm packages..."
npm install --production 2>&1 | tail -1
echo -e "${GREEN}  ✓ Dependencies installed${NC}"

# ─────────────────────────────────────────────────────────────
# STEP 6: Environment check
# ─────────────────────────────────────────────────────────────
echo -e "${YELLOW}[6/6] Verifying environment...${NC}"

# Check .env
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        echo -e "${YELLOW}  ⚠ .env not found. Copying from .env.example...${NC}"
        cp .env.example .env
        echo -e "${YELLOW}  ⚠ Edit .env with your Binance API keys before starting!${NC}"
    else
        echo -e "${RED}  ✗ .env.example not found!${NC}"
    fi
else
    echo -e "${GREEN}  ✓ .env found${NC}"
fi

# Verify Node modules
if node -e "require('ws'); require('axios');" 2>/dev/null; then
    echo -e "${GREEN}  ✓ Core modules load correctly${NC}"
else
    echo -e "${RED}  ✗ Core modules missing. Run: npm install${NC}"
fi

# Check timezone
echo "  Server time: $(date)"
echo "  Timezone: $(timedatectl show --property=Timezone --value 2>/dev/null || echo 'UTC')"

# ─────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────
echo ""
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║  SETUP COMPLETE                                          ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""
echo -e "  ${GREEN}Node.js:${NC}  $(node -v)"
echo -e "  ${GREEN}npm:${NC}      $(npm -v)"
echo -e "  ${GREEN}PM2:${NC}      $(pm2 -v)"
echo -e "  ${GREEN}Server:${NC}   $(uname -n) ($(uname -m))"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Edit .env with your Binance API keys:"
echo "     nano .env"
echo ""
echo "  2. Start the shadow runner:"
echo "     pm2 start ecosystem.config.js"
echo ""
echo "  3. Monitor logs:"
echo "     pm2 logs bulletbrain-shadow"
echo ""
echo "  4. Check regime umpire reports:"
echo "     tail -f logs/umpire.log"
echo ""
echo "  5. Save PM2 config (survives reboot):"
echo "     pm2 save"
echo ""
