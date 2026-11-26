# Poker Platform

A tabletop chip and pot accounting domain for No-Limit Texas Hold'em cash games played with physical cards.

## Language

### Session & Ledger

**Session**:
A single No-Limit Texas Hold'em cash-game gathering played with physical cards, from opening the ledger to final **Settlement**.
_Avoid_: Match, event

**Player**:
A participant seated in a **Session** who holds **Chips**, acts in **Hands**, and settles on the ledger.
_Avoid_: User, account, member

**Chip**:
A unit of virtual wagering value used during a **Session**, pegged to a **Cash** exchange rate.
_Avoid_: Point, coin, credit

**Cash**:
Real-world currency value tracked on the **Session** ledger for **Buy-In**s and **Settlement**, never processed as payments.
_Avoid_: Money, real money, bankroll

**Host**:
The **Player** or organizer who creates a **Session**, configures its table rules, manages the ledger, and can act on behalf of any **Seat**.
_Avoid_: Admin, moderator, banker

**Seat**:
A numbered table position in a **Session** that can be open, occupied by an active **Player**, or sitting out.

**Buy-In**:
A recorded acquisition of **Chips** by a **Player** during a **Session**, adding to their **Cash** obligation on the ledger.
_Avoid_: Deposit, load

**Rebuy**:
A **Buy-In** taken between **Hands** by a **Player** whose stack is zero **Chips**.

**Top-Up**:
A **Buy-In** taken between **Hands** by an active **Player** to raise a non-zero stack up to the **Session** maximum.
_Avoid_: Add-on

**Cash-Out**:
The locking of an exiting **Player**'s remaining **Chip** stack mid-**Session**, fixing their ending position for **Settlement**.

**Settlement**:
The end-of-**Session** calculation of net **Cash** owed between **Players** from total **Buy-In**s versus ending **Chip** stacks.
_Avoid_: Payout, reconciliation

### Hand & Betting

**Hand**:
A single deal of physical cards from blind posting until all **Pots** are awarded.
_Avoid_: Round, game

**Button**:
The rotating dealer position in a **Hand** that determines blind order, acting order, and odd-chip tie-breaking priority.
_Avoid_: Dealer

**Ante**:
A forced pre-deal **Chip** contribution posted before cards are dealt into the **Main Pot**, either by every **Seat** or by the big blind **Seat**.

**Straddle**:
An optional voluntary blind wager posted before cards are dealt that increases the effective stake and reopens preflop raising for the straddling **Seat**.

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

**Run It Twice**:
An optional all-in agreement that splits each contested **Pot** into two independent **Showdown** halves, each resolved separately.
