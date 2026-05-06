name: Monitor websites

on:
  schedule:
    - cron: "0 8,20 * * *"
  workflow_dispatch:

# Voorkomt dat twee runs tegelijk draaien (bijv. bij handmatige trigger tijdens geplande run)
concurrency:
  group: monitoring
  cancel-in-progress: false

permissions:
  contents: read
  pages: write
  id-token: write
  issues: write

jobs:
  monitor:
    runs-on: ubuntu-latest
    timeout-minutes: 90  # 59 sites × ~6 pagina's sequentieel kan 45-60 min duren

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 24  # Geüpdatet: Node 20 deprecated per 2 juni 2026

      - run: npm install

      - run: npx playwright install --with-deps chromium

      - name: Run monitor
        run: npm run monitor
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}

      - uses: actions/upload-pages-artifact@v3
        with:
          path: dashboard

  deploy:
    needs: monitor
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment:
      name: github-pages

    steps:
      - uses: actions/deploy-pages@v4
