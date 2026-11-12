# Demo script

A walk through the flagship market, for a live demo or for a reviewer trying the app. It takes about five minutes. Everything below runs on the seeded flagship market, so the numbers repeat.

## Before you start

- Open the hosted app, or run it locally (README, Getting started). The hosted API sleeps when idle, so the first request can take about a minute.
- PayPal steps need sandbox credentials on the server and a sandbox buyer account. Without them the interface says that payments are not configured and shows nothing as paid.
- Times in the interface are Stockholm time.

## Act I: Impossible

1. On the first screen the request reads: "Produce and deliver 500 promotional kits to Stockholm by Friday 12:00, under 55 000 kr." Press **Make it possible**.
2. The page opens the market (27 actors: suppliers and carriers across five stages), reads the request and tests every combination of offers.
3. The result is a proof, not a search result. **Why it fails** lists the 14 constraints that cannot hold together, each as one sentence: Kista's working window, Lindqvists' capacity of 200 kits, an offer that expired, a minimum order of 1000 that the buyer cannot meet. "Remove any one and the order works."
4. One line stands out: Snabbpack Norden claims room for 500 kits, but 450 are already booked by others. A plan that trusted the claim would look cheap and be false.

## Act II: Invent

1. **Invent** shows what Framvera will ask: Kista works two hours later, and Roslagens Åkeri and Lindqvists Transport share one van. Each change has a planner estimate, labelled as such.
2. Press the ask button. Suppliers answer from private limits and the answer carries its source. Kista counters with an overtime charge; the carriers accept.
3. The outcome becomes possible at 52 600 kr, under the 55 000 kr budget, marked "Independently checked": a second verifier with no solver code re-checked capacity, windows, precedence, deadline and budget.
4. To see a person answer instead, create a seat link under **Create link**, open it in a second window (`#/seller/<market>/<supplier>`) and answer there. The answer is recorded as given by a person at the seller terminal.

## Act III: Commit and pay

1. **Approve and commit**. Each party signs the exact terms hash. The agreement lists who owes what and when.
2. Under Commit · Payment, press **Create PayPal order** for a supplier. The order is created in the PayPal sandbox and waits for the buyer.
3. Press **Approve in PayPal** and approve with a sandbox buyer. The interface does not capture before approval; PayPal's own status decides.
4. Capture, then open the proof: order id, capture id, PayPal's status string and the time it was fetched. **Fetch again from PayPal** reads it a second time.
5. Each supplier is a separate order. They are not one atomic payment, and the page says "PayPal Sandbox, test money".

## Act IV: Break and recover

1. Press **Break the deal**. A supplier withdraws after accepting. The affected obligation is hatched in the schedule.
2. Framvera finds a recovery that keeps every accepted promise it can. **What changed** shows only the replaced obligation and the extra cost.
3. **Rejected plans** shows a cheaper plan that was refused because it would have changed an accepted obligation, with the reason.
4. If the withdrawn supplier had been paid, the refund is offered here and needs its own approval.

## Try your own

- **Try another market** on the first screen opens other scenarios or a seed you choose. Seeds you have not seen may be feasible as published, repairable, or impossible; the page says which and shows the proof when it is impossible.
- **Change a limit yourself** (under Discover) lets you relax a constraint and re-solve in the browser to see what it would unlock.
- The Evidence route shows every event with its source and the events that caused it.
