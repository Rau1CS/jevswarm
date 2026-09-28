"""Shared drone components: brushless outrunner motor, two-blade propeller, fasteners."""
import math
from mathutils import Matrix, Vector
from drone_lib import T, TAU

# Local motor height (2216 class) from mount face to prop seat; the prop origin sits here.
MOTOR_PROP_SEAT = 0.033


def motor(b, M, windows=6):
    """2216-class outrunner at local origin, axis +Y (scale with M for bigger motors)."""
    R = 0.0142
    b.cyl('alu', 0.0132, 0.003, M, seg=24)                               # stator base / mount boss
    b.cyl('copper', 0.0116, 0.016, M @ T(y=0.003), seg=24)               # wound stator
    if b.hi:
        for k in range(12):                                              # individual coil bumps
            a = k / 12 * TAU
            b.box('copper', 0.0042, 0.013, 0.0024, M @ T(math.sin(a) * 0.0117, 0.0105, math.cos(a) * 0.0117, ry=a))
        span = TAU / windows
        for k in range(windows):                                         # bell spokes (ventilation windows)
            a0 = k * span
            b.lathe('alu', [(0.0132, 0.006), (R, 0.006), (R, 0.0172), (0.0132, 0.0172), (0.0132, 0.006)],
                    M, seg=6, a0=a0, a1=a0 + span * 0.62)
        b.lathe('steel', [(0.0132, 0.003), (R, 0.003), (R, 0.006), (0.0132, 0.006), (0.0132, 0.003)], M, seg=32)
    else:
        b.cyl('alu', R, 0.014, M @ T(y=0.003), seg=16)
    b.lathe('alu', [(0, 0.0172), (R, 0.0172), (R, 0.0222), (0.0138, 0.0236), (0.011, 0.0249), (0.0045, 0.0255), (0, 0.0255)], M, seg=32)
    if b.hi:
        for k in range(4):                                               # bell cap screws
            a = k / 4 * TAU + TAU / 8
            b.lathe('steel', [(0, 0.0249), (0.0013, 0.0249), (0.0013, 0.0255), (0.0009, 0.0259), (0, 0.0259)],
                    M @ T(math.sin(a) * 0.0078, 0, math.cos(a) * 0.0078), seg=8)
        b.box('steel', 0.0022, 0.0009, 0.0022, M @ T(0.004, 0.0249, 0.0))   # balance mark / set screw
    b.cyl('steel', 0.004, 0.0035, M @ T(y=0.0255), seg=16)                # prop collet
    b.cyl('steel', 0.0025, 0.009, M @ T(y=0.029), seg=12)                 # threaded shaft
    b.cyl('steel', 0.0046, 0.004, M @ T(y=0.037), seg=6)                  # hex prop nut
    b.lathe('steel', [(0, 0.041), (0.0035, 0.041), (0.0026, 0.0435), (0, 0.0445)], M, seg=12)


def _airfoil(n):
    """Closed cambered airfoil loop (x 0..1 from LE, y normalised), 2*n points."""
    xs = [0.5 - 0.5 * math.cos(math.pi * i / (n - 1)) for i in range(n)]
    up, lo = [], []
    for x in xs:
        yt = 5 * (0.2969 * math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4)
        yc = 0.05 / 0.16 * (0.8 * x - x * x) if x < 0.4 else 0.05 / 0.36 * (0.2 + 0.8 * x - x * x)
        up.append((x, yc + yt))
        lo.append((x, yc - yt))
    return up[::-1] + lo[1:-1]


def prop(b, R, pitch, hub_r, hub_h, M=Matrix.Identity(4), mat='prop'):
    """Two-blade propeller at origin, CCW viewed from above (mirror M on Z for CW)."""
    n_st = 18 if b.hi else 7
    foil = _airfoil(9 if b.hi else 4)
    r0 = hub_r * 0.55
    for blade in (0, 1):
        rings = []
        for i in range(n_st):
            t = i / (n_st - 1)
            t = 1 - (1 - t) ** 1.25
            r = r0 + (R - r0) * t
            c = R * (0.105 + 0.1 * math.sin(math.pi * (t * 0.8 + 0.12))) * (1 - 0.72 * t ** 7)
            c *= 0.42 + 0.58 * min(1.0, t / 0.22) ** 0.7        # narrow neck into the hub
            tc = 0.16 - 0.09 * t
            th = min(math.atan(pitch / (TAU * max(r, 1e-3))), math.radians(26))
            if t < 0.12:                                   # root blends toward a thick, flat hub neck
                th *= 0.55 + 3.75 * t
            e = Vector((0, -math.sin(th), math.cos(th)))
            nn = Vector((0, math.cos(th), math.sin(th)))
            sweep = 0.035 * R * t * t
            ring = []
            for x, y in foil:
                d = (x - 0.32) * c
                p = Vector((r, 0, sweep)) + e * d + nn * (y * tc * c * 1.0)
                ring.append(tuple(p))
            rings.append(ring)
        rot = T(ry=math.pi * blade)
        b.loft(mat, rings, M @ rot, cap0=True, cap1=True)
    b.lathe(mat, [(0, -hub_h / 2), (hub_r * 0.85, -hub_h / 2), (hub_r, -hub_h * 0.3), (hub_r, hub_h * 0.3),
                  (hub_r * 0.8, hub_h / 2), (0, hub_h / 2)], M, seg=20)


def screw(b, M, r=0.0015):
    """Socket-head cap screw head, axis +Y."""
    if b.hi:
        b.lathe('steel', [(0, 0), (r, 0), (r, r * 1.1), (r * 0.55, r * 1.1), (r * 0.55, r * 0.7), (0, r * 0.7)], M, seg=8)
