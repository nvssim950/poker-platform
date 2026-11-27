# Poker Platform

A casual tabletop chip and pot companion for No-Limit Texas Hold'em played with physical cards and play Chips.

## Language

### Session & Standings

**Session**:
A single No-Limit Texas Hold'em gathering played with physical cards and play Chips, from opening the table to final **End Game** standings.
_Avoid_: Match, event

**Player**:
A participant seated in a **Session** who holds **Chips** and acts in **Hands**.
_Avoid_: User, account, member

**Chip**:
A unit of virtual play-only wagering value used during a **Session**.
_Avoid_: Point, coin, credit

**Host**:
The **Player** or organizer who creates a **Session**, configures Starting Stack and Blinds, starts **Hands**, resolves **Showdowns**, and can act as a proxy for any **Seat**.
_Avoid_: Admin, moderator, banker

**Seat**:
A numbered table position in a **Session** that can be open, occupied by an active **Player**, or sitting out.

**Starting Stack**:
The fixed number of **Chips** automatically granted to a **Player** when claiming an open **Seat**.

**Rebuy**:
An instant self-service refill of the **Starting Stack** taken between **Hands** by a **Player** whose stack is zero **Chips**, with no **Host** approval required.

**Leave**:
A **Player** action between **Hands** that vacates their **Seat** back to open while snapshotting their final **Chip** standing on the **Leaderboard**.

**Release**:
A **Host** action between **Hands** that removes a **Player** from an occupied **Seat**, vacates it back to open, and snapshots their final **Chip** standing on the **Leaderboard**.

**Leaderboard**:
The live or final ranking of all **Session** participants (active and departed) by net **Chips** (`endingChips - totalIssuedChips`), current **Chips**, and **Rebuy** count.

**End Game**:
The **Host** action between **Hands** that closes the **Session** and locks the final **Leaderboard**.

### Hand & Betting

**Hand**:
A single deal of physical cards from blind posting until all **Pots** are awarded.
_Avoid_: Round, game

**Button**:
The rotating dealer position in a **Hand** that determines blind order, acting order, and odd-chip tie-breaking priority.
_Avoid_: Dealer

**Street**:
One betting phase within a **Hand**: Preflop, Flop, Turn, or River.
_Avoid_: Betting round, phase, stage

**Action**:
A **Player**'s turn decision within a **Street**: Fold, Check, Call, Bet, Raise, or All-In.
_Avoid_: Move, play

**Pot**:
A pool of **Chips** wagered during a **Hand** to be awarded to one or more winning **Players**.

**Main Pot**:
The primary **Pot** of a **Hand** that every non-folded **Player** is eligible to win.

**Side Pot**:
An additional **Pot** formed when an all-in **Player** cannot match further wagers, contested only by the **Players** who matched into it.

**Showdown**:
The resolution of a **Hand** when two or more **Players** remain after the final **Street**, where winning **Players** for each **Pot** are declared directly rather than evaluated from card rankings.
