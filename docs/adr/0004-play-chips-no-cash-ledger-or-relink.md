# 0004. Play Chips Without Cash Ledger or Device Re-Link

Partially supersedes [0002-typescript-sqlite-websocket-stack.md](./0002-typescript-sqlite-websocket-stack.md) (replacing Settlement with the Chip Leaderboard) and [0003-accountless-room-tokens-host-authority.md](./0003-accountless-room-tokens-host-authority.md).

We simplified the Session model to focus on casual play-Chip No-Limit Texas Hold'em for fun rather than cash-game accounting. Claiming a Seat automatically issues the Session's Starting Stack, busted Players can take an instant self-service Rebuy between Hands without Host approval, and a live/final Chip Leaderboard plus Host End Game replaces the Cash ledger, Buy-In/Cash-Out approvals, Cash Settlement transfers, and Re-link QR flows. Accountless room join links and Host authority over starting Hands, Showdown winner selection, Undo, Seat removal, and proxy Actions remain unchanged.
