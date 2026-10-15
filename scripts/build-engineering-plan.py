# Builds src/layouts/engineering.json from points read off the hand sketch
# (the photo turned upright, positions in its pixel coordinates).
#
#   python3 scripts/build-engineering-plan.py src/layouts/engineering.json /tmp/new.json
#
# The first file supplies the name, floor, hours and area names to keep. To move
# a table or seat, change its sketch coordinates below and rebuild. The drawing's bottom wall slopes a little,
# so y is normalised between the top wall and that sloping bottom line.
import json, sys

def bottom(px):            # sketch bottom wall, sloping from left to right
    return 662 - 0.094 * px

TOP = 65
W_OUT, H_OUT = 1580, 470

def P(px, py):
    x = (px - 40) * 0.88
    y = (py - TOP) / (bottom(px) - TOP) * (H_OUT - 10) + 5
    return [round(x), round(y)]

def box(px1, py1, px2, py2):
    x1, y1 = P(px1, py1); x2, y2 = P(px2, py2)
    x, y = max(6, min(x1, x2)), min(y1, y2)
    return {"x": x, "y": y, "w": max(x1, x2) - x, "h": abs(y2 - y1)}

# ---- walls (snapped to clean lines) ------------------------------------------
Y_LEFT_TOP = 70      # top of the west wing (top-left strip)
Y_NOTCH = 110        # step down at the top-left
Y_FRONT = 175        # front wall with the entrance
Y_BACK = 465         # window wall along the bottom
X_NOTCH1 = 140
X_NOTCH2 = 265
X_EAST_BLOCK = 1145  # where the discussion-room block rises
Y_EAST_TOP = 5
X_RIGHT = 1570

outline = [
    [0, Y_LEFT_TOP], [X_NOTCH1, Y_LEFT_TOP], [X_NOTCH1, Y_NOTCH], [X_NOTCH2, Y_NOTCH],
    [X_NOTCH2, Y_FRONT], [X_EAST_BLOCK, Y_FRONT], [X_EAST_BLOCK, Y_EAST_TOP],
    [X_RIGHT, Y_EAST_TOP], [X_RIGHT, Y_BACK], [0, Y_BACK],
]

rooms, stacks, tables, seats, zones = [], [], [], [], []

def seat(zone, px, py):
    seats.append({"zone": zone, "x": P(px, py)[0], "y": P(px, py)[1]})

def rect(px1, py1, px2, py2):
    tables.append({"shape": "rect", **box(px1, py1, px2, py2)})

def roundt(px, py, r=14):
    x, y = P(px, py)
    tables.append({"shape": "round", "cx": x, "cy": y, "r": r})

def stack(px1, py1, px2, py2):
    stacks.append(box(px1, py1, px2, py2))

def room(label, px1, py1, px2, py2, kind="room"):
    rooms.append({"label": label, **box(px1, py1, px2, py2), "kind": kind})

# ---- West end ---------------------------------------------------------------
stack(45, 165, 200, 190)                          # shelf strip along the top-left
rect(170, 237, 265, 258)                          # bench in the notch
seat("W", 190, 226); seat("W", 242, 226)
rect(55, 255, 80, 355)                            # wall table, 4 computers
for py in (264, 289, 315, 341): seat("W", 98, py)
rect(42, 410, 66, 500)                            # wall table, 3 computers
for py in (425, 456, 489): seat("W", 88, py)
rect(170, 290, 194, 328); seat("W", 158, 298); seat("W", 158, 320)
rect(158, 355, 182, 395); seat("W", 145, 367); seat("W", 145, 390)
rect(155, 445, 176, 492); seat("W", 142, 455); seat("W", 142, 485)
room("Office", 32, 535, 192, 612)

# ---- Window wall (south), west half ------------------------------------------
rect(282, 586, 366, 610); seat("S", 302, 573); seat("S", 348, 573)
rect(436, 576, 560, 601)
for px in (452, 487, 522, 552): seat("S", px, 563)
rect(652, 562, 757, 587)
for px in (667, 697, 730, 752): seat("S", px, 551)

# ---- The floor (centre): the lounge row ------------------------------------
rect(428, 424, 467, 447); seat("C", 436, 412); seat("C", 458, 412)
stack(484, 400, 496, 462)
roundt(533, 424, 13); seat("C", 533, 403)
stack(560, 400, 572, 462)
rect(588, 412, 637, 432); roundt(612, 422, 11)
for px in (598, 614, 630): seat("C", px, 398)
stack(646, 400, 658, 462)
roundt(713, 410, 15); seat("C", 713, 386)
stack(745, 400, 757, 462)
roundt(791, 412, 15); seat("C", 791, 388)
stack(822, 400, 834, 462)
zones.append({"label": "Open space", "x": P(955, 410)[0], "y": P(955, 410)[1], "kind": "inside"})

# ---- Reception, entrance, discussion rooms ----------------------------------
room("Reception", 1068, 245, 1278, 365, kind="desk")
room("Room 1", 1384, 72, 1487, 170)
room("Room 2", 1489, 72, 1552, 170)
room("Room 3", 1554, 72, 1640, 170)

# ---- The floor, east side ----------------------------------------------------
stack(1380, 262, 1392, 350)
roundt(1442, 284, 15); seat("C", 1420, 266)
roundt(1442, 330, 15); seat("C", 1424, 314)
roundt(1497, 232, 15); seat("C", 1497, 208)
rect(1567, 254, 1630, 282); seat("C", 1580, 242); seat("C", 1617, 242)
rect(1567, 322, 1632, 350); seat("C", 1576, 311); seat("C", 1612, 311)
rect(1575, 400, 1640, 432); seat("C", 1588, 389); seat("C", 1622, 389)

# ---- East wall ---------------------------------------------------------------
rect(1678, 98, 1702, 157)
seat("E", 1663, 110); seat("E", 1663, 144); seat("E", 1716, 110); seat("E", 1716, 144)
rect(1730, 196, 1752, 284)
for py in (210, 232, 254, 276): seat("E", 1716, py)
rect(1748, 304, 1766, 362)
for py in (314, 334, 354): seat("E", 1733, py)
rect(1590, 470, 1668, 496)
for px in (1610, 1636, 1660): seat("E", px, 456)
room("Office", 1712, 382, 1800, 480)

# ---- Window wall (south), east half -----------------------------------------
rect(1126, 512, 1214, 542)
for px in (1136, 1158, 1180, 1202): seat("S", px, 499)
rect(1270, 511, 1294, 536); seat("S", 1282, 497)
rect(1356, 498, 1437, 525)
for px in (1364, 1384, 1405, 1426): seat("S", px, 487)
rect(1500, 482, 1530, 505); seat("S", 1515, 470)

# ---- ids: per zone, left to right then top to bottom -------------------------
out_seats = []
for z in "WSCE":
    zs = [s for s in seats if s["zone"] == z]
    # West end: column by column, top to bottom. East wall: top to bottom.
    # Window wall and the floor: left to right.
    if z == "W":
        zs.sort(key=lambda s: (s["x"] // 60, s["y"]))
    elif z == "E":
        zs.sort(key=lambda s: (s["y"] // 40, s["x"]))
    else:
        zs.sort(key=lambda s: (round(s["x"] / 30), s["y"]))
    for i, s in enumerate(zs, 1):
        out_seats.append({"id": f"{z}{i}", "x": s["x"], "y": s["y"]})

old = json.load(open(sys.argv[1]))
plan = {
    "name": old["name"],
    "floor": old["floor"],
    "viewBox": [0, 0, X_RIGHT, Y_BACK + 5],
    "note": f"Drawn from the detailed hand sketch of the library, with {len(out_seats)} seats. "
            "Seat ids here are the library's seat ids (unless SEAT_IDS_ENGINEERING is set). "
            "Move a seat by editing its x/y; add or remove seats freely, then regenerate QR codes "
            "(npm run qr). The map turns this plan to portrait on narrow screens.",
    "outline": outline,
    "zones": [{"label": "Atrium", "x": 700, "y": 95, "kind": "outside"}] + zones,
    "rooms": rooms,
    "stacks": stacks,
    "tables": tables,
    "seats": out_seats,
    "entrance": {"x": P(935, 260)[0], "y": Y_FRONT, "label": "Enter"},
    "hours": old["hours"],
    "zoneNames": old["zoneNames"],
}
json.dump(plan, open(sys.argv[2], "w"), indent=2)
from collections import Counter
print(len(out_seats), Counter(s["id"][0] for s in out_seats))

import itertools

# ---- make room for the seat badges -------------------------------------------
# The sketch isn't to scale: seats on one table sit closer than a tappable seat
# badge (about 30 plan units). Seats on the same table are spread evenly along
# the table's long side to at least MIN apart, and the table grows to fit.
MIN = 32

def near(t, s, pad=26):
    if t["shape"] != "rect":
        return False
    return t["x"] - pad <= s["x"] <= t["x"] + t["w"] + pad and t["y"] - pad <= s["y"] <= t["y"] + t["h"] + pad

for t in plan["tables"]:
    group = [s for s in plan["seats"] if near(t, s)]
    if len(group) < 2:
        continue
    horizontal = t["w"] >= t["h"]
    key = "x" if horizontal else "y"
    # Seats on opposite sides of a table (e.g. 2 + 2) share positions along it.
    lanes = {}
    for s in group:
        side = "y" if horizontal else "x"
        lanes.setdefault(round(s[side] / 20), []).append(s)
    for lane in lanes.values():
        lane.sort(key=lambda s: s[key])
        n = len(lane)
        if n < 2:
            continue
        span_now = lane[-1][key] - lane[0][key]
        span = max(span_now, MIN * (n - 1))
        mid = (lane[0][key] + lane[-1][key]) / 2
        for i, s in enumerate(lane):
            s[key] = round(mid - span / 2 + i * span / (n - 1))
    lo = min(s[key] for s in group) - 16
    hi = max(s[key] for s in group) + 16
    if horizontal:
        t["x"], t["w"] = min(t["x"], lo), max(t["x"] + t["w"], hi) - min(t["x"], lo)
    else:
        t["y"], t["h"] = min(t["y"], lo), max(t["y"] + t["h"], hi) - min(t["y"], lo)

# Anything still too close (seats between two tables): nudge each pair apart
# along whichever axis they are already more separated on.
for _ in range(40):
    moved = False
    for a, b in itertools.combinations(plan["seats"], 2):
        dx, dy = b["x"] - a["x"], b["y"] - a["y"]
        if abs(dx) < 30 and abs(dy) < 30:
            k = "x" if abs(dx) >= abs(dy) else "y"
            d = dx if k == "x" else dy
            push = (30 - abs(d)) / 2 + 1
            sgn = 1 if d >= 0 else -1
            a[k] = round(a[k] - sgn * push); b[k] = round(b[k] + sgn * push)
            moved = True
    if not moved:
        break

# report anything still too close
import itertools
close = [(a["id"], b["id"]) for a, b in itertools.combinations(plan["seats"], 2)
         if abs(a["x"] - b["x"]) < 28 and abs(a["y"] - b["y"]) < 28]
print("still overlapping:", close)
json.dump(plan, open(sys.argv[2], "w"), indent=2)
