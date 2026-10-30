# Repo Pulse - Just commands
# https://github.com/casey/just

# Default recipe - show available commands
default:
    @just --list

# Install dependencies
install:
    npm ci

# Start local Workers development
dev:
    npm run dev

# Build for production
build:
    npm run build

# Deploy to Cloudflare
deploy:
    npm run deploy

# Generate Cloudflare binding types
typegen:
    npm run typegen

# Apply D1 migrations locally
db-migrate-local:
    npm run db:migrate:local

# Apply D1 migrations remotely
db-migrate-remote:
    npm run db:migrate:remote

# Clean build artifacts and coverage
clean:
    rm -rf dist coverage .wrangler

# Run tests
test:
    npm run test

# Run tests in watch mode
test-watch:
    npm run test:watch

# Run tests with coverage
test-coverage:
    npm run test:coverage

# Run ESLint
lint:
    npm run lint

# Fix ESLint issues
lint-fix:
    npm run lint:fix

# Format code with Biome
format:
    npm run format

# Check code with Biome
check:
    npm run check

# Type check with TypeScript
typecheck:
    npm run typecheck

# Run all verification checks
verify:
    npm run verify

# Find unused code with Knip
knip:
    npm run knip

# Fix unused code issues
knip-fix:
    npm run knip:fix

# Check admin health status
config-status:
    @printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_API_TOKEN" | curl -s --config - http://localhost:8787/admin/health | jq

# Add the Repo Pulse webhook to GitHub repositories (skips ones already subscribed)
subscribe url +repos:
    scripts/subscribe.sh {{url}} {{repos}}

# Remove the Repo Pulse webhook from GitHub repositories, recording each one first (--dry-run to preview)
unsubscribe *args:
    scripts/unsubscribe.sh {{args}}

# Check that each listed repository has an active, fully subscribed webhook answering a fresh ping (--repair to fix hooks first)
check-coverage *args:
    scripts/check-coverage.sh {{args}}

# Copy local Cloudflare secrets template
setup-config:
    cp .dev.vars.example .dev.vars
    @echo "Created .dev.vars. Edit the secrets before running wrangler dev."
