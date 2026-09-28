"""
HEAVY airframe: coaxial X8 heavy-lift suppression platform, ~1.9 m motor-to-motor span,
30 in props (upper + counter-rotating lower), 40 mm folding carbon arms, ~20 L HDPE tank,
pump, gimballed directed nozzle, dual RTK GNSS, terrain radar, sprung skid landing gear.
Coordinates: metres, +Y up, +Z forward, +X port.
"""
import math
from drone_lib import T, TAU, rrect, bevel_profile, JEV, TXT_SUPP, SMARTBAT, LEVEL, NOSTEP, SUPPRESSANT, HEAVYLIFT, HAZARD, IDPLATE, CAUTION
from drone_common import motor, prop, screw, MOTOR_PROP_SEAT

K = 'HEAVY'
MOTOR_R = 0.95
ARM_Y = 0.035
MS = 3.2                                  # motor scale vs 2216 (≈ 90 mm bell, 8120 class)
UP_BASE, LO_BASE = 0.075, -0.005
UP_PROP = UP_BASE + MOTOR_PROP_SEAT * MS
LO_PROP = LO_BASE - MOTOR_PROP_SEAT * MS
DIAG = [(1, 1), (-1, 1), (-1, -1), (1, -1)]


def _d(sx, sz):
    return sx / math.sqrt(2), sz / math.sqrt(2)


def fuselage(b):
    b.at(K, 'frame')
    for y0 in (-0.004, 0.071):
        b.slab('carbon', lambda ins: rrect(0.40, 0.46, 0.07, 6 if b.hi else 2, ins),
               [(i, y0 + y) for i, y in bevel_profile(0.004, 0.001, 1 if b.hi else 0)])
    for sx, sz in DIAG:
        for off in (0.1, 0.17):
            b.cyl('alu', 0.007, 0.071, T(sx * off, 0.0, sz * off * 1.1), seg=12)
    b.at(K, 'canopy')
    n = 6 if b.hi else 2
    prof = [(0.0, 0.075), (0.002, 0.1), (0.01, 0.135), (0.028, 0.165), (0.055, 0.185), (0.09, 0.196), (0.12, 0.2)]
    if not b.hi:
        prof = prof[::2] + [prof[-1]]
    b.slab('paint', lambda ins: rrect(0.38, 0.54, 0.13, n, ins), prof, T(0, 0, 0.01))
    b.rbox('paint', 0.2, 0.06, 0.1, 0.03, 0.02, T(0, 0.1, 0.27, rx=-0.35))              # nose fairing
    b.decal('decal', 0.16, HEAVYLIFT, T(0.1695, 0.13, 0.05, ry=math.pi / 2, rz=0.0))
    b.decal('decal', 0.16, HEAVYLIFT, T(-0.1695, 0.13, 0.05, ry=-math.pi / 2))
    b.decal('decal', 0.1, JEV, T(0, 0.2006, 0.14, rx=-math.pi / 2, ry=math.pi))
    b.decal('decal', 0.08, NOSTEP, T(0.0, 0.2006, 0.02, rx=-math.pi / 2, ry=math.pi))
    for x in (-0.08, 0.08):
        b.rbox('plastic_dark', 0.05, 0.006, 0.12, 0.01, 0.002, T(x, 0.19, -0.02))          # cooling vents
    b.at(K, 'fc')
    b.rbox('plastic_light', 0.05, 0.016, 0.085, 0.006, 0.002, T(0, 0.085, 0.08))
    b.rbox('pcb', 0.09, 0.003, 0.1, 0.003, 0.001, T(0, 0.08, -0.06))
    b.at(K, 'battery')                                                  # smart battery with handle
    b.rbox('plastic_dark', 0.19, 0.08, 0.27, 0.02, 0.006, T(0, 0.175, -0.12))                  # battery dock
    b.rbox('battery', 0.17, 0.11, 0.25, 0.018, 0.01, T(0, 0.255, -0.12))
    b.decal('decal', 0.17, SMARTBAT, T(0.0852, 0.255, -0.12, ry=math.pi / 2))
    b.decal('decal', 0.17, SMARTBAT, T(-0.0852, 0.255, -0.12, ry=-math.pi / 2))
    b.tube('plastic_dark', [(0, 0.31, -0.2), (0, 0.345, -0.18), (0, 0.35, -0.12), (0, 0.345, -0.06), (0, 0.31, -0.04)], 0.009, seg=12)
    for k in range(5 if b.hi else 0):
        b.cyl('led', 0.003, 0.001, T(0.03 - k * 0.015, 0.3105, 0.0))
    b.at(K, 'gnss')                                                     # dual RTK antennas (heading)
    for sx in (-1, 1):
        b.tube('carbon', [(sx * 0.15, 0.19, 0.12), (sx * 0.2, 0.33, 0.12)], 0.007, seg=12)
        b.lathe('plastic_light', [(0, 0), (0.05, 0), (0.051, 0.006), (0.046, 0.016), (0.03, 0.024), (0, 0.027)], T(sx * 0.2, 0.33, 0.12), seg=32)
    b.at(K, 'radar')                                                    # terrain-following + forward radar
    b.rbox('plastic_dark', 0.13, 0.03, 0.09, 0.01, 0.004, T(0, -0.02, 0.2, rx=0.25))
    b.rbox('plastic_light', 0.11, 0.07, 0.022, 0.012, 0.005, T(0, 0.1, 0.33, rx=-0.3))
    b.rbox('plastic_dark', 0.04, 0.032, 0.03, 0.008, 0.003, T(0, 0.04, 0.3))           # FPV camera
    b.cyl('glass', 0.009, 0.004, T(0, 0.04, 0.315, rx=math.pi / 2), seg=16)


def arms(b):
    b.at(K, 'arms')
    for sx, sz in DIAG:
        dx, dz = _d(sx, sz)
        a = math.atan2(dx, dz)
        b.tube('carbon', [(dx * 0.12, ARM_Y, dz * 0.12), (dx * (MOTOR_R - 0.04), ARM_Y, dz * (MOTOR_R - 0.04))], 0.02, seg=24)
        b.rbox('anod', 0.06, 0.06, 0.07, 0.012, 0.004, T(dx * 0.225, ARM_Y, dz * 0.225, ry=a))     # root clamp
        f = 0.36                                                          # folding joint
        b.lathe('anod', [(0, -0.045), (0.026, -0.045), (0.028, -0.04), (0.028, 0.04), (0.026, 0.045), (0, 0.045)],
                T(dx * f, ARM_Y, dz * f, rx=math.pi / 2, ry=a), seg=24)
        b.lathe('plastic_dark', [(0, 0), (0.018, 0), (0.018, 0.012), (0.014, 0.016), (0, 0.016)],
                T(dx * f, ARM_Y + 0.026, dz * f), seg=16)
        b.rbox('plastic_dark', 0.012, 0.012, 0.075, 0.004, 0.002, T(dx * f + dz * 0.03, ARM_Y + 0.03, dz * f - dx * 0.03, ry=a))
        b.cyl('steel', 0.006, 0.07, T(dx * f - dz * 0.03, ARM_Y - 0.035, dz * f + dx * 0.03), seg=12)
        if b.hi:
            for k in (-1, 1):
                screw(b, T(dx * (f + k * 0.03), ARM_Y + 0.027, dz * (f + k * 0.03)), 0.004)
        b.rbox('alu', 0.05, 0.03, 0.14, 0.008, 0.003, T(dx * 0.7, ARM_Y - 0.035, dz * 0.7, ry=a))   # ESC heatsink
        for k in range(7 if b.hi else 2):
            o = -0.018 + k * (0.036 / (6 if b.hi else 1))
            b.box('alu', 0.003, 0.014, 0.13, T(dx * 0.7 - dz * o, ARM_Y - 0.056, dz * 0.7 + dx * o, ry=a))
        b.at(K, 'motors')
        m = MOTOR_R
        b.lathe('anod', [(0, 0), (0.034, 0), (0.034, UP_BASE - LO_BASE), (0, UP_BASE - LO_BASE)], T(dx * m, LO_BASE, dz * m), seg=24)
        b.lathe('anod', [(0, -0.03), (0.027, -0.03), (0.027, 0.03), (0, 0.03)], T(dx * (m - 0.045), ARM_Y, dz * (m - 0.045), rx=math.pi / 2, ry=a), seg=20)
        motor(b, T(dx * m, UP_BASE, dz * m, ry=a, s=MS))
        motor(b, T(dx * m, LO_BASE, dz * m, rx=math.pi, ry=a, s=MS))
        b.at(K, 'arms')


def tank(b):
    b.at(K, 'tank')
    yc = -0.17
    b.rbox('tank', 0.34, 0.26, 0.32, 0.07, 0.045, T(0, yc, 0), n=6)
    b.rbox('paint', 0.3445, 0.04, 0.3245, 0.07, 0.004, T(0, yc + 0.05, 0), n=6)
    for z in (-0.08, 0.08):                                              # moulded ribs
        b.rbox('tank', 0.346, 0.2, 0.012, 0.004, 0.003, T(0, yc - 0.01, z))
    b.decal('decal', 0.036, LEVEL, T(0.1705, yc - 0.03, -0.12, ry=math.pi / 2))
    b.decal('decal', 0.2, SUPPRESSANT, T(0.1705, yc - 0.03, 0.03, ry=math.pi / 2))
    b.decal('decal', 0.2, SUPPRESSANT, T(-0.1705, yc - 0.03, 0.03, ry=-math.pi / 2))
    b.decal('decal', 0.22, HAZARD, T(0, yc - 0.1, 0.1605))
    b.lathe('plastic_dark', [(0, 0), (0.045, 0), (0.045, 0.018), (0.04, 0.026), (0, 0.026)], T(0.08, yc + 0.125, 0.1), seg=24)  # fill cap
    for sx, sz in DIAG:                                                   # tank mount brackets
        b.rbox('anod', 0.03, 0.05, 0.03, 0.006, 0.002, T(sx * 0.13, -0.03, sz * 0.12))
    b.at(K, 'pump')
    py = yc - 0.13
    b.lathe('alu', [(0, 0), (0.035, 0), (0.037, 0.006), (0.037, 0.06), (0.03, 0.07), (0, 0.07)], T(-0.035, py - 0.02, -0.12, rz=-math.pi / 2), seg=24)
    b.lathe('plastic_dark', [(0, 0), (0.04, 0), (0.04, 0.05), (0, 0.05)], T(-0.085, py - 0.02, -0.12, rz=-math.pi / 2), seg=24)
    if b.hi:
        for k in range(8):
            a = k / 8 * TAU
            b.box('alu', 0.05, 0.004, 0.012, T(-0.005, py - 0.02 + math.sin(a) * 0.037, -0.12 + math.cos(a) * 0.037, rx=-a))
    b.tube('rubber', [(0.035, py - 0.02, -0.12), (0.06, py - 0.03, -0.08), (0.06, py - 0.035, 0.08), (0.03, py - 0.04, 0.19), (0, py - 0.04, 0.22)], 0.012, seg=12)
    b.at(K, 'nozzle')                                                    # 2-axis directed nozzle turret
    nz, ny = 0.24, py - 0.03
    b.lathe('alu', [(0, 0), (0.04, 0), (0.04, 0.02), (0.034, 0.028), (0, 0.028)], T(0, ny, nz), seg=24)
    b.rbox('plastic_dark', 0.1, 0.02, 0.04, 0.006, 0.003, T(0, ny - 0.01, nz))
    for sx in (-1, 1):
        b.rbox('plastic_dark', 0.014, 0.07, 0.04, 0.005, 0.002, T(sx * 0.045, ny - 0.045, nz))
    b.lathe('alu', [(0, 0), (0.016, 0), (0.016, 0.086), (0, 0.086)], T(0.043, ny - 0.065, nz, rz=math.pi / 2), seg=16)
    tilt = math.radians(32)
    M = T(0, ny - 0.065, nz, rx=math.pi / 2 + tilt)
    b.lathe('alu', [(0, -0.04), (0.028, -0.04), (0.03, -0.02), (0.03, 0.03), (0.022, 0.08), (0.016, 0.16), (0, 0.16)], M, seg=24)
    b.lathe('steel', [(0, 0.155), (0.017, 0.155), (0.015, 0.19), (0.009, 0.2), (0, 0.2)], M, seg=20)
    b.lathe('paint', [(0.0305, -0.005), (0.0305, 0.02)], M, seg=24)


def gear(b):
    b.at(K, 'gear')
    for sx in (-1, 1):
        for sz in (-1, 1):
            top = (sx * 0.15, -0.006, sz * 0.17)
            bot = (sx * 0.37, -0.52, sz * 0.22)
            b.rbox('anod', 0.06, 0.03, 0.06, 0.01, 0.003, T(top[0], top[1] - 0.012, top[2]))
            b.tube('carbon', [top, bot], 0.016, seg=18)
            b.rbox('plastic_dark', 0.05, 0.05, 0.055, 0.012, 0.004, T(bot[0], bot[1] + 0.008, bot[2]))
            b.cyl('steel', 0.009, 0.1, T(sx * 0.3, -0.36, sz * 0.205, rz=sx * 0.4), seg=12)   # damper strut
        b.tube('carbon', [(sx * 0.37, -0.52, -0.46), (sx * 0.37, -0.52, 0.46)], 0.016, seg=18)
        for sz in (-1, 1):
            b.tube('rubber', [(sx * 0.37, -0.52, sz * 0.3), (sx * 0.37, -0.52, sz * 0.44)], 0.024, seg=18)
            b.lathe('rubber', [(0, 0), (0.017, 0), (0.017, 0.012), (0.011, 0.02), (0, 0.021)], T(sx * 0.37, -0.52, sz * 0.46, rx=sz * math.pi / 2), seg=16)
    for sz in (-1, 1):
        b.tube('carbon', [(-0.26, -0.3, sz * 0.197), (0.26, -0.3, sz * 0.197)], 0.011, seg=14)


def props(b):
    for kit, mirror in (('PROP_H_CCW', 1), ('PROP_H_CW', -1)):
        b.at(kit, 'prop')
        prop(b, 0.381, 0.254, 0.03, 0.028, T(s=(1, 1, mirror)))


def build_heavy(b):
    fuselage(b)
    arms(b)
    tank(b)
    gear(b)
    props(b)
