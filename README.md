# keyworddm-cloud

This repo was created by the **KeywordDM** app. It runs your comment-to-DM campaigns on GitHub Actions, so DMs keep going out while your computer is off.

- `.github/workflows/check-comments.yml` checks your running campaigns every 5 minutes.
- `.github/workflows/fast-mode.yml` checks every 10 seconds for a few hours after you start a campaign.
- `data/campaigns.enc` holds your campaign settings and `data/state.enc` records who already got a DM. Both are **encrypted**, so nobody can read them even though the repo is public. (Public repos get free, unlimited Actions minutes.)
- Your Instagram token is stored in this repo's encrypted **Actions secrets**, which are never shown publicly or given to forks.

Manage everything from the KeywordDM app. Don't edit these files by hand; the app replaces them when it updates.
