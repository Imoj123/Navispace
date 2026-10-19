# Builds src/layouts/engineering.json: the Engineering Library floor plan.
#
#   python3 scripts/build-engineering-plan.py src/layouts/engineering.json src/layouts/engineering.json
#
# The first file supplies the name, floor, hours and area names to keep.
#
# Everything is laid out on a clean grid in plan units (the plan is 1570 x 470),
# following the hand sketch: rows are straight, and seats that share a table sit
# PITCH apart so their badges never touch. To move something, change its numbers
# here and rebuild. Seat ids are given per area (W, S, C, E) in reading order.
import itertools
import json
import sys

PITCH = 36          # distance between neighbouring seats on one table
SEAT_GAP = 18       # seat centre to table edge

outline = [
    [0, 14], [190, 14], [190, 110], [265, 110], [265, 175],
    [1145, 175], [1145, 5], [1570, 5], [1570, 465], [0, 465],
]

rooms, stacks, tables, zones = [], [], [], []
seats = {"W": [], "S": [], "C": [], "E": []}


def rect(x, y, w, h):
    tables.append({"shape": "rect", "x": x, "y": y, "w": w, "h": h})


def round_table(cx, cy, r=14):
    tables.append({"shape": "round", "cx": cx, "cy": cy, "r": r})


def shelf(x, y, w, h):
    stacks.append({"x": x, "y": y, "w": w, "h": h})


def room(label, x, y, w, h, kind="room", book=None):
    r = {"label": label, "x": x, "y": y, "w": w, "h": h, "kind": kind}
    if book:                                            # a discussion room students can book (src/rooms.js)
        r["id"] = book
        r["bookable"] = True
    rooms.append(r)


def row_table(zone, x, y, n, side="above"):
    """A table with n seats in a row along one long side. Returns its right edge."""
    w = n * PITCH
    rect(x, y, w, 18)
    sy = y - SEAT_GAP if side == "above" else y + 18 + SEAT_GAP
    for i in range(n):
        seats[zone].append((x + PITCH / 2 + i * PITCH, sy))
    return x + w


def column_table(zone, x, y, n, side="left"):
    """A table with n seats down one long side. Returns its bottom edge."""
    h = n * PITCH
    rect(x, y, 16, h)
    sx = x - SEAT_GAP - 4 if side == "left" else x + 16 + SEAT_GAP + 4
    for i in range(n):
        seats[zone].append((sx, y + PITCH / 2 + i * PITCH))
    return y + h


# ---- West end: three straight columns ------------------------------------
shelf(10, 26, 50, 8)                                    # shelf strip in the top corner
column_table("W", 12, 118, 4, side="right")            # wall table, 4 computers
column_table("W", 12, 270, 3, side="right")            # wall table, 3 computers
for y in (118, 210, 302):                               # three small tables for two
    column_table("W", 118, y, 2, side="left")
row_table("W", 79, 72, 2)                               # bench above W8-W9
room("Office", 8, 400, 130, 58)

# ---- Window wall: every table on one straight line -------------------------
ROW = 432
x = row_table("S", 180, ROW, 2)                         # S1-S2
x = row_table("S", 300, ROW, 4)                         # S3-S6
x = row_table("S", 500, ROW, 4)                         # S7-S10
x = row_table("S", 880, ROW, 4)                         # S11-S14
x = row_table("S", 1052, ROW, 1)                        # S15
x = row_table("S", 1116, ROW, 4)                        # S16-S19
x = row_table("S", 1290, ROW, 1)                        # S20
row_table("E", 1346, ROW, 3)                            # E12-E14, by the east office
room("Office", 1470, 400, 92, 58)

# ---- The floor: the lounge row, a shelf in each gap ------------------------
# Starts between S2 and S3 and ends well before the entrance.
LOUNGE_Y = 300       # table centre line
GAP = 22

def lounge_shelf(x):
    shelf(x, LOUNGE_Y - 24, 10, 52)
    return x + 10 + GAP

x = 274
x = row_table("C", x, LOUNGE_Y - 9, 2) + GAP           # table for two
x = lounge_shelf(x)
round_table(x + 14, LOUNGE_Y); seats["C"].append((x + 14, LOUNGE_Y - 27)); x += 28 + GAP
x = lounge_shelf(x)
x = row_table("C", x, LOUNGE_Y - 9, 2) + GAP           # table for two
x = lounge_shelf(x)
for _ in range(2):                                      # two round tables for one
    round_table(x + 15, LOUNGE_Y, 15); seats["C"].append((x + 15, LOUNGE_Y - 27)); x += 30 + GAP
    x = lounge_shelf(x)
LOUNGE_END = x

# ---- Entrance, reception, discussion rooms --------------------------------
ENTRANCE_X = 838
room("Reception", 905, 182, 184, 112, kind="desk")
room("Room 1", 1180, 12, 92, 100, book="R1")
room("Room 2", 1276, 12, 62, 100, book="R2")
room("Room 3", 1342, 12, 62, 100, book="R3")

# ---- The floor, east side ---------------------------------------------------
shelf(1150, 210, 10, 120)
round_table(1205, 248, 15); seats["C"].append((1205, 221))
round_table(1205, 320, 15); seats["C"].append((1205, 293))
round_table(1278, 168, 15); seats["C"].append((1278, 141))
for y in (222, 290, 358):                               # three tables for two, one column
    row_table("C", 1314, y, 2)

# ---- East wall: corner table, then two wall tables in one line ------------
rect(1476, 22, 16, 72)                                  # corner table by Room 3, 2 + 2;
for y in (40, 76):                                      # its right seats line up with E5-E11
    seats["E"].append((1454, y)); seats["E"].append((1514, y))
y = column_table("E", 1536, 110, 4, side="left")       # E5-E8
bottom = column_table("E", 1536, y + 30, 3, side="left")  # E9-E11, a clear gap above
assert bottom < 400, "the east wall tables must stop above the office"

# ---- ids --------------------------------------------------------------------
out_seats = []
for zone, pts in seats.items():
    if zone == "W":      # in layout order: wall tables, small tables, then the bench
        pass
    elif zone == "E":    # top to bottom, left to right
        pts.sort(key=lambda p: (p[1] // 30, p[0]))
    elif zone == "C":    # left to right; a table's two seats read across
        pts.sort(key=lambda p: (p[0] // 60, p[1], p[0]))
    else:                # left to right
        pts.sort(key=lambda p: (p[0], p[1]))
    for i, (x, y) in enumerate(pts, 1):
        out_seats.append({"id": f"{zone}{i}", "x": round(x), "y": round(y)})

# Every seat badge needs its own space.
close = [(a["id"], b["id"]) for a, b in itertools.combinations(out_seats, 2)
         if abs(a["x"] - b["x"]) < 32 and abs(a["y"] - b["y"]) < 32]
assert not close, f"seats too close: {close}"
assert LOUNGE_END < ENTRANCE_X - 30 < 905, "the lounge row must end before the entrance"

old = json.load(open(sys.argv[1]))
plan = {
    "name": old["name"],
    "floor": old["floor"],
    "viewBox": [0, 0, 1570, 470],
    "note": f"The Engineering Library floor, drawn from the hand sketch on a clean grid, with "
            f"{len(out_seats)} seats. Built by scripts/build-engineering-plan.py: edit positions "
            "there and rebuild, then regenerate QR codes (npm run qr) if seats change. "
            "The map turns this plan to portrait on narrow screens.",
    "outline": outline,
    "zones": [{"label": "Atrium", "x": 700, "y": 95, "kind": "outside"}],
    "rooms": rooms,
    "stacks": stacks,
    "tables": tables,
    "seats": out_seats,
    "entrance": {"x": ENTRANCE_X, "y": 175, "label": "Enter"},
    "hours": old["hours"],
    "zoneNames": old["zoneNames"],
}
json.dump(plan, open(sys.argv[2], "w"), indent=2)
counts = {z: sum(1 for s in out_seats if s["id"][0] == z) for z in "WSCE"}
print(len(out_seats), counts)
