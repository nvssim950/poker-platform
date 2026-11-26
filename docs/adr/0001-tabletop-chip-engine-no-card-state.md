# 0001. Tabletop Chip Engine Without Card State

We are building a tabletop poker companion for games played with real physical cards, so the platform intentionally omits card decks, shuffling, card input, and hand-ranking evaluation. At Showdown, winners are picked manually per Pot (supporting ties and auto-awarding single-eligible pots), trading automated card evaluation for speed at a live table and avoiding forcing players to reveal mucked side-pot hands just to rank everyone.
