# RideFlow — real-time ride booking

A working ride-hailing platform: passengers book Bike / Auto / Mini / Sedan rides on a live map, nearby drivers
get real-time requests, and every trip runs through PIN verification, fare calculation, payment, receipt and rating.
Rides and payments are **simulated** (test cards, bot drivers). Nothing here moves real money.

**Stack:** React 19 + Vite, MapLibre GL 3D maps (MapTiler vector tiles), Socket.IO, Express 5, SQLite (Node's built-in `node:sqlite`),
OSRM road routing, Nodemailer.

## Run it

Requires Node.js **22.5+** (uses the built-in SQLite driver).

```bash
npm install
cp .env.example .env        # then set MAPTILE_API_KEY (and JWT_SECRET)
npm run dev                 # API on :4000 + web app on http://localhost:5173
```

Production-style single server: `npm run build && npm start` → http://localhost:4000

The database (`server/data/rideflow.db`) is created and seeded on first start. `npm run db:reset` wipes it.

### Demo accounts

| Role | Email | Password |
|---|---|---|
| Passenger | rider@rideflow.app | rider123 |
| Driver (Mini) | driver@rideflow.app | driver123 |
| Admin | admin@rideflow.app | admin123 |

The login page has one-click buttons for each. New passengers get ₹200 test wallet credit.

### Try the full flow

* **One browser:** log in as the rider, pick a destination, book. A simulated bot driver accepts, drives to you
  along real roads, verifies your PIN, drives you to the destination and completes the trip.
* **Two browsers (real driver):** open a private window as the driver and click **Go online**, then book as the
  rider. The request appears on the driver screen with a 30-second countdown (bots hold back 20 s when a real
  driver is nearby). Accept → *Navigate to pickup (simulated)* → *I've arrived* → enter the PIN the passenger sees →
  *Drive to destination* → *Complete trip*. On a desktop you can tap the map to move the driver's car.

## Ride lifecycle

```
scheduled ─(5 min before pickup)─┐
                                 ▼
requested ──accept──▶ accepted ──arrived──▶ arrived ──PIN──▶ in_progress ──complete──▶ completed ──▶ rated
    │                    │                     │
    │ 3 min, no taker    │ driver cancels → back to requested & re-dispatched
    ▼                    ▼
 no_driver           cancelled (passenger: free < 3 min after accept, fee after that or once the driver arrived)
```

All transitions live in `server/rideService.js`, shared by HTTP routes, sockets and the bot simulator.

## Features

| Area | What's implemented |
|---|---|
| Location & map | Browser geolocation (fallback city), nearby drivers refreshed live, tap-to-set pickup/destination, MapTiler geocoding search |
| Fares | Base + per-km + per-minute per category, minimum fares, 5% tax; **dynamic surge** from live demand/supply within 6 km plus peak-hour and night components (cap 2.5×) |
| Dispatch | Real-time `ride:request` to online, free, same-category drivers within 6 km; atomic accept (first driver wins); decline / auto-expire offers |
| Live tracking | Driver location over Socket.IO, smooth marker movement, ETA, trip progress, remaining route |
| Trip PIN | 4-digit PIN shown only to the passenger; 5 wrong attempts lock the start |
| Payment | Cash, wallet, test card; charge recorded at drop-off with transaction id; printable receipt |
| Earnings | 15% (bike/auto) / 20% (cars) commission; promos are absorbed by the platform; driver daily/weekly/monthly payouts |
| Scheduling | Up to 7 days ahead, surge-free locked price, auto-dispatch 5 minutes before pickup |
| Promo codes | Percent/flat, max discount, minimum fare, per-user and total limits, category-specific, expiry; seeded: `WELCOME50`, `FLAT30`, `BIKE20`, `SEDAN100` |
| Cancellations & refunds | Fee rules + driver compensation, promo restored on cancel, refund requests reviewed by admin and credited to the wallet |
| Safety | SOS during a ride (alerts admin live + emails emergency contacts), call 112, shareable public live-trip link |
| Email | Welcome, scheduled, driver assigned, receipt, cancellation, refund, SOS. Sent via SMTP when configured, otherwise stored and viewable in Admin → Emails |
| Admin | KPIs, rides/revenue per day, demand by hour, category & payment mix, top drivers, live map of drivers and rides, ride/user/promo management, refunds, SOS desk, CSV export |

**Test cards (wallet top-up):** `4242 4242 4242 4242` succeeds, `4000 0000 0000 0002` is declined. Any future expiry and any CVV.

The admin analytics include ~30 days of seeded demo history (Bengaluru) so the charts aren't empty.

## Project layout

```
server/
  index.js         Express + Socket.IO bootstrap, background jobs, serves dist/ in production
  rideService.js   ride state machine, payments, cancellations, refunds, SOS
  fare.js          vehicle categories, surge, promos, commission
  sim.js           bot drivers (position, accept, drive real OSRM routes, PIN, complete)
  geo.js           distance, OSRM routing, MapTiler/Nominatim geocoding
  db.js, seed.js   schema + first-run seed
  routes/          auth, rides (passenger), driver, account (wallet/contacts), admin
src/
  pages/passenger  booking flow, history, account
  pages/driver     driver console, earnings
  pages/admin      dashboard
  components/      map, charts, SOS, shell
```

## Image credits

Vehicle photos in `public/vehicles/` come from Wikimedia Commons under CC BY / CC BY-SA licences; authors and links are in [public/vehicles/CREDITS.md](public/vehicles/CREDITS.md). Keep that attribution if you deploy. The phone screens in `public/screens/` are screenshots of this app.

## Before a real launch

This is an educational build. Going live needs, at minimum: driver KYC and background checks, a real payment gateway
(and PCI scope review), production-grade routing and maps quotas, SMS/OTP verification, real emergency-response
operations, data-protection compliance, insurance, and local transport/aggregator licensing.
