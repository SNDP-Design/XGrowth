# XGrowth admin scripts

## Export all signups + their product profiles → `users.csv`

### One-time setup

1. **Get a service account key**
   - Go to [Firebase Console](https://console.firebase.google.com) → project **xgrowth-351de**
   - Click the **gear icon** (top left) → **Project settings**
   - Open the **Service accounts** tab
   - Click **Generate new private key** → confirm → a `.json` file downloads
   - Move/rename that file to: **`scripts/serviceAccountKey.json`**
   - ⚠️ Never commit or share this file — it has full admin access. (It's already git-ignored.)

2. **Install dependencies**
   ```sh
   cd scripts
   npm install
   ```

### Run it (anytime)

```sh
cd scripts
npm run export
```

This writes **`scripts/users.csv`** with one row per signup:

| email | name | signed_up | last_sign_in | product_name | stage | website | what_it_does | competitors | uid |
|-------|------|-----------|--------------|--------------|-------|---------|--------------|-------------|-----|

Newest signups first. Open it in Excel / Google Sheets / Numbers.

It also prints the 10 most recent signups to your terminal for a quick glance.
