"""
LIGHT airframe: X500-V2-class 500 mm quad (carbon plates, 16 mm tube arms with folding
clamps, 2216 motors, 1045 props, 4S pack on rails, Pixhawk-class FC, GNSS mast, skids)
plus the four role payload modules. Coordinates: metres, +Y up, +Z forward, +X port.
"""
import math
from drone_lib import T, TAU, rrect, bevel_profile, HAZARD, JEV, TXT_SCOUT, TXT_SUPP, TXT_LOGI, TXT_RELAY, LIPO, ARROW, CAUTION, IDPLATE, TANK15, NOSTEP
from drone_common import motor, prop, screw, MOTOR_PROP_SEAT

MOTOR_R = 0.25                 # 500 mm wheelbase
ARM_Y = 0.009                  # arm tube centreline
MOTOR_BASE_Y = 0.021
PROP_Y = MOTOR_BASE_Y + MOTOR_PROP_SEAT
DIAG = [(1, 1), (-1, 1), (-1, -1), (1, -1)]
RAIL_Y = -0.028


def _arm_dir(sx, sz):
    return sx / math.sqrt(2), sz / math.sqrt(2)


def frame(b):
    b.at('LIGHT', 'frame')
    plate = lambda ins: rrect(0.15, 0.2, 0.035, 6 if b.hi else 2, ins)
    for y0 in (-0.012, 0.027):
        b.slab('carbon', plate, [(i, y0 + y) for i, y in bevel_profile(0.0022, 0.0006, 1 if b.hi else 0)])
        if b.hi:                                                       # lightening slots (boolean cut)
            b.cutmode = True
            for sx in (-1, 1):
                for k in (-1, 0, 1):
                    b.slab('carbon', lambda ins: rrect(0.016, 0.036, 0.0075, 4, ins), [(0, y0 - 0.01), (0, y0 + 0.01)],
                           T(sx * 0.042, 0, k * 0.054))
            b.cyl('carbon', 0.012, 0.02, T(0, y0 - 0.01, 0), seg=24)
            b.cutmode = False
    for sx, sz in DIAG:                                                # aluminium standoffs + screws
        for off in (0.045, 0.075):
            x, z = sx * off * 0.8, sz * off
            b.cyl('alu', 0.0035, 0.039, T(x, -0.0098, z), seg=10)
            screw(b, T(x, 0.0292, z), 0.0028)
    for sx, sz in DIAG:
        dx, dz = _arm_dir(sx, sz)
        a = math.atan2(dx, dz)
        b.tube('carbon', [(dx * 0.05, ARM_Y, dz * 0.05), (dx * (MOTOR_R + 0.012), ARM_Y, dz * (MOTOR_R + 0.012))], 0.008, seg=20)
        # folding arm clamp: split collar, hinge pin, locking knob
        c = 0.105
        b.rbox('anod', 0.03, 0.026, 0.036, 0.006, 0.002, T(dx * c, ARM_Y, dz * c, ry=a))
        b.cyl('steel', 0.0032, 0.032, T(dx * c + dz * 0.017, ARM_Y - 0.016, dz * c - dx * 0.017), seg=10)
        b.lathe('plastic_dark', [(0, 0), (0.007, 0), (0.0075, 0.002), (0.0075, 0.007), (0.005, 0.009), (0, 0.009)],
                T(dx * c - dz * 0.017, ARM_Y + 0.004, dz * c + dx * 0.017, rz=0), seg=12 if b.hi else 8)
        if b.hi:
            for k in (-1, 1):
                screw(b, T(dx * (c + k * 0.009), ARM_Y + 0.013, dz * (c + k * 0.009)), 0.0018)
        # motor mount: tube collar + motor plate
        m = MOTOR_R
        b.lathe('anod', [(0, -0.012), (0.0105, -0.012), (0.0105, 0.012), (0, 0.012)], T(dx * (m - 0.028), ARM_Y, dz * (m - 0.028), rx=math.pi / 2, ry=a), seg=16)
        b.rbox('anod', 0.034, 0.004, 0.05, 0.012, 0.001, T(dx * (m - 0.008), MOTOR_BASE_Y - 0.002, dz * (m - 0.008), ry=a))
        b.rbox('anod', 0.02, 0.012, 0.03, 0.004, 0.001, T(dx * (m - 0.02), ARM_Y + 0.005, dz * (m - 0.02), ry=a))
        if b.hi:                                                       # ESC + phase wires under the arm
            b.rbox('plastic_dark', 0.016, 0.007, 0.045, 0.002, 0.001, T(dx * 0.16, ARM_Y - 0.012, dz * 0.16, ry=a))
            for k in (-1, 0, 1):
                px, pz = -dz * k * 0.0035, dx * k * 0.0035
                b.tube('rubber', [(dx * m + px, MOTOR_BASE_Y + 0.001, dz * m + pz), (dx * (m - 0.03) + px, ARM_Y - 0.01, dz * (m - 0.03) + pz),
                                  (dx * 0.185 + px, ARM_Y - 0.011, dz * 0.185 + pz)], 0.0012, seg=5)
    # payload / battery rails (X500 V2 style 10 mm rods) with clamps under the bottom plate
    for sx in (-1, 1):
        b.tube('carbon', [(sx * 0.035, RAIL_Y, -0.13), (sx * 0.035, RAIL_Y, 0.13)], 0.005, seg=14)
        for z in (-0.06, 0.06):
            b.rbox('anod', 0.016, 0.02, 0.014, 0.003, 0.001, T(sx * 0.035, RAIL_Y + 0.006, z))
    # depth camera bar at the nose
    b.at('LIGHT', 'depth')
    b.rbox('plastic_dark', 0.075, 0.02, 0.016, 0.004, 0.002, T(0, 0.009, 0.107))
    for x in (-0.026, 0.026):
        b.cyl('alu', 0.0055, 0.002, T(x, 0.009, 0.1145, rx=math.pi / 2), seg=16)
        b.cyl('glass', 0.0042, 0.0006, T(x, 0.009, 0.1165, rx=math.pi / 2), seg=16)
    b.cyl('glass', 0.0025, 0.0008, T(0.008, 0.009, 0.1152, rx=math.pi / 2), seg=10)
    b.cyl('germanium', 0.0022, 0.0008, T(-0.008, 0.009, 0.1152, rx=math.pi / 2), seg=10)


def canopy(b):
    b.at('LIGHT', 'canopy')
    n = 6 if b.hi else 2
    prof = [(0.0, 0.0292), (0.001, 0.036), (0.004, 0.047), (0.01, 0.059), (0.019, 0.067), (0.029, 0.0725), (0.04, 0.0745)]
    if not b.hi:
        prof = prof[::2] + [prof[-1]]
    b.slab('paint', lambda ins: rrect(0.126, 0.178, 0.045, n, ins), prof, T(0, 0, -0.004))
    b.decal('decal', 0.046, JEV, T(0, 0.0748, 0.012, rx=-math.pi / 2, ry=math.pi))
    b.decal('decal', 0.036, IDPLATE, T(0, 0.0748, -0.03, rx=-math.pi / 2, ry=math.pi))
    b.rbox('plastic_dark', 0.05, 0.004, 0.006, 0.002, 0.001, T(0, 0.0733, -0.058))          # rear vent grille
    b.rbox('plastic_dark', 0.03, 0.006, 0.004, 0.002, 0.001, T(0, 0.052, 0.083, rx=-0.5))  # front status window
    for x in (-0.009, 0.009):
        b.cyl('led', 0.0018, 0.0008, T(x, 0.053, 0.0852, rx=math.pi / 2 - 0.5), seg=8)


def avionics(b):
    b.at('LIGHT', 'fc')                                                 # Pixhawk-class FC on dampers
    for x in (-0.018, 0.018):
        for z in (0.012, 0.062):
            b.sphere('rubber', 0.0035, T(x, 0.0325, z), seg=10)
    b.rbox('plastic_light', 0.044, 0.014, 0.07, 0.006, 0.002, T(0, 0.042, 0.037))
    b.rbox('plastic_dark', 0.03, 0.002, 0.05, 0.004, 0.0008, T(0, 0.0495, 0.037))
    if b.hi:
        for k in range(5):
            b.box('plastic_dark', 0.006, 0.004, 0.003, T(-0.016 + k * 0.008, 0.041, 0.0725))
        b.cyl('led', 0.0015, 0.001, T(0.012, 0.05, 0.058), seg=8)
    b.at('LIGHT', 'companion')                                          # companion computer + heatsink
    b.rbox('pcb', 0.052, 0.0018, 0.062, 0.002, 0.0005, T(0, 0.033, -0.045))
    b.rbox('alu', 0.04, 0.004, 0.044, 0.002, 0.0008, T(0, 0.036, -0.045))
    for k in range(9 if b.hi else 3):
        b.box('alu', 0.0012, 0.012, 0.042, T(-0.018 + k * (0.036 / (8 if b.hi else 2)), 0.044, -0.045))
    b.box('plastic_dark', 0.012, 0.006, 0.01, T(0.02, 0.037, -0.074))
    b.at('LIGHT', 'gnss')                                               # folding GNSS mast
    b.rbox('plastic_dark', 0.018, 0.012, 0.022, 0.003, 0.001, T(0, 0.0805, -0.06))
    b.cyl('steel', 0.002, 0.022, T(-0.011, 0.083, -0.06, rz=-math.pi / 2), seg=8)
    b.tube('carbon', [(0, 0.083, -0.06), (0, 0.165, -0.06)], 0.0042, seg=12)
    b.lathe('plastic_dark', [(0, 0.162), (0.022, 0.162), (0.024, 0.166), (0, 0.166)], T(0, 0, -0.06), seg=28)
    b.lathe('plastic_light', [(0, 0.166), (0.03, 0.166), (0.031, 0.17), (0.029, 0.176), (0.022, 0.182), (0.012, 0.1848), (0, 0.1855)],
            T(0, 0, -0.06), seg=32)
    b.decal('decal', 0.016, ARROW, T(0, 0.1857, -0.06, rx=-math.pi / 2, ry=math.pi))
    b.at('LIGHT', 'radio')                                              # telemetry antennas on rear arms
    for sx in (-1, 1):
        dx, dz = _arm_dir(sx, -1)
        base = (dx * 0.14, ARM_Y - 0.009, dz * 0.14)
        b.cyl('plastic_dark', 0.004, 0.006, T(base[0], base[1] - 0.006, base[2]), seg=10)
        b.tube('plastic_dark', [(base[0], base[1] - 0.006, base[2]), (base[0] + sx * 0.012, base[1] - 0.075, base[2] - 0.01)], 0.0033, seg=8,
               radii=[0.0038, 0.0028])
    b.at('LIGHT', 'wiring')
    if b.hi:
        b.tube('wire_red', [(0.006, -0.04, 0.075), (0.006, -0.03, 0.09), (0.006, -0.008, 0.085), (0.006, 0.0, 0.07)], 0.0022, seg=8)
        b.tube('rubber', [(-0.006, -0.04, 0.075), (-0.006, -0.03, 0.09), (-0.006, -0.008, 0.085), (-0.006, 0.0, 0.07)], 0.0022, seg=8)
        b.rbox('plastic_dark', 0.02, 0.009, 0.014, 0.002, 0.001, T(0, -0.04, 0.083))            # XT60 connector


def battery(b):
    b.at('LIGHT', 'battery')
    b.rbox('carbon', 0.064, 0.002, 0.16, 0.006, 0.0005, T(0, RAIL_Y - 0.007, 0))
    b.rbox('battery', 0.048, 0.04, 0.15, 0.004, 0.003, T(0, RAIL_Y - 0.029, 0))
    b.decal('decal', 0.09, LIPO, T(0.0242, RAIL_Y - 0.029, 0, ry=math.pi / 2))
    b.decal('decal', 0.09, LIPO, T(-0.0242, RAIL_Y - 0.029, 0, ry=-math.pi / 2))
    for z in (-0.045, 0.045):                                            # hook-and-loop straps + buckle
        b.rbox('rubber', 0.052, 0.046, 0.02, 0.004, 0.001, T(0, RAIL_Y - 0.027, z))
        b.rbox('plastic_dark', 0.016, 0.004, 0.024, 0.002, 0.001, T(0.0, RAIL_Y - 0.051, z))
    if b.hi:
        b.tube('rubber', [(0.018, RAIL_Y - 0.02, -0.075), (0.018, RAIL_Y - 0.02, -0.085), (0.01, RAIL_Y - 0.012, -0.09)], 0.003, seg=6)
        b.rbox('plastic_light', 0.014, 0.004, 0.008, 0.001, 0.0005, T(0.01, RAIL_Y - 0.01, -0.093))


def gear(b):
    b.at('LIGHT', 'gear')
    for sx in (-1, 1):
        for sz in (-1, 1):
            top = (sx * 0.05, -0.013, sz * 0.068)
            bot = (sx * 0.12, -0.252, sz * 0.085)
            b.rbox('anod', 0.022, 0.012, 0.022, 0.004, 0.001, T(top[0], top[1] - 0.004, top[2]))
            b.tube('carbon', [top, bot], 0.0065, seg=14)
            b.rbox('plastic_dark', 0.02, 0.022, 0.024, 0.005, 0.002, T(bot[0], bot[1] + 0.004, bot[2]))
        b.tube('carbon', [(sx * 0.12, -0.252, -0.165), (sx * 0.12, -0.252, 0.165)], 0.0065, seg=14)
        for sz in (-1, 1):                                                # foam feet + end plugs
            b.tube('rubber', [(sx * 0.12, -0.252, sz * 0.105), (sx * 0.12, -0.252, sz * 0.158)], 0.0105, seg=14)
            b.cyl('rubber', 0.0068, 0.004, T(sx * 0.12, -0.252, sz * 0.165, rx=sz * math.pi / 2), seg=12)
        b.tube('carbon', [(sx * 0.066, -0.075, -0.073), (sx * 0.066, -0.075, 0.073)], 0.004, seg=10)


def motors(b):
    b.at('LIGHT', 'motors')
    for sx, sz in DIAG:
        dx, dz = _arm_dir(sx, sz)
        motor(b, T(dx * MOTOR_R, MOTOR_BASE_Y, dz * MOTOR_R, ry=sx * sz * 0.3))


def props(b):
    for kit, mirror in (('PROP_L_CCW', 1), ('PROP_L_CW', -1)):
        b.at(kit, 'prop')
        prop(b, 0.127, 0.1143, 0.0095, 0.009, T(s=(1, 1, mirror)))


# ---------------------------------------------------------------------------- payloads
def _rail_hanger(b, z, drop, w=0.07):
    """Rail clamps + drop plate at longitudinal position z, reaching down to y = RAIL_Y - drop."""
    for sx in (-1, 1):
        b.lathe('anod', [(0, -0.008), (0.0078, -0.008), (0.0078, 0.008), (0, 0.008)], T(sx * 0.035, RAIL_Y, z, rx=math.pi / 2), seg=14)
    b.rbox('anod', w, 0.004, 0.018, 0.003, 0.001, T(0, RAIL_Y - 0.009, z))
    b.rbox('alu', 0.006, drop, 0.014, 0.002, 0.0008, T(0, RAIL_Y - 0.009 - drop / 2, z))


def payload_scout(b):
    b.at('PAY_SCOUT', 'payload')
    z0 = 0.112
    _rail_hanger(b, 0.1, 0.012)
    b.rbox('alu', 0.05, 0.003, 0.04, 0.006, 0.001, T(0, -0.05, z0))
    for x in (-0.018, 0.018):
        for dz in (-0.013, 0.013):
            b.sphere('rubber', 0.0048, T(x, -0.0555, z0 + dz), seg=10)
    b.rbox('alu', 0.05, 0.003, 0.04, 0.006, 0.001, T(0, -0.061, z0))
    b.lathe('alu', [(0, 0), (0.013, 0), (0.0142, 0.003), (0.0142, 0.011), (0.012, 0.013), (0, 0.013)], T(0, -0.076, z0), seg=24)
    b.rbox('plastic_dark', 0.006, 0.05, 0.014, 0.002, 0.001, T(-0.031, -0.095, z0))           # yaw-pitch yoke
    b.rbox('plastic_dark', 0.062, 0.006, 0.014, 0.002, 0.001, T(0, -0.073, z0))
    b.lathe('alu', [(0, 0), (0.011, 0), (0.012, 0.002), (0.012, 0.009), (0, 0.009)], T(-0.026, -0.105, z0, rz=math.pi / 2), seg=20)
    b.rbox('plastic_dark', 0.048, 0.038, 0.046, 0.009, 0.003, T(0.003, -0.105, z0 + 0.004))    # camera housing
    b.decal('decal', 0.03, TXT_SCOUT, T(0.0272, -0.094, z0 + 0.004, ry=math.pi / 2))
    zf = z0 + 0.027
    b.lathe('alu', [(0, 0), (0.0125, 0), (0.0125, 0.008), (0.011, 0.009), (0, 0.009)], T(0.012, -0.105, zf, rx=math.pi / 2), seg=24)
    b.lathe('germanium', [(0, 0.0088), (0.0098, 0.0088), (0.006, 0.0102), (0, 0.0106)], T(0.012, -0.105, zf, rx=math.pi / 2), seg=24)
    b.lathe('alu', [(0, 0), (0.0078, 0), (0.0078, 0.006), (0.007, 0.007), (0, 0.007)], T(-0.012, -0.108, zf, rx=math.pi / 2), seg=20)
    b.lathe('glass', [(0, 0.0068), (0.0055, 0.0068), (0.0035, 0.008), (0, 0.0083)], T(-0.012, -0.108, zf, rx=math.pi / 2), seg=20)
    b.cyl('glass', 0.0022, 0.001, T(-0.012, -0.093, zf, rx=math.pi / 2), seg=10)             # laser rangefinder


def payload_suppression(b):
    b.at('PAY_SUPPRESSION', 'payload')
    yc, R, L = -0.142, 0.052, 0.19
    for z in (-0.06, 0.06):
        _rail_hanger(b, z, 0.022)
        b.lathe('anod', [(R + 0.0005, -0.007), (R + 0.004, -0.007), (R + 0.004, 0.007), (R + 0.0005, 0.007)], T(0, yc, z, rx=math.pi / 2), seg=32)
    prof = [(0, -L / 2)] + [(R * math.sin(a), -L / 2 + R - R * math.cos(a)) for a in (k / 6 * TAU / 4 for k in range(1, 7))] + \
           [(R * math.cos(a), L / 2 - R + R * math.sin(a)) for a in (k / 6 * TAU / 4 for k in range(0, 6))] + [(0, L / 2)]
    b.lathe('tank', prof, T(0, yc, 0, rx=math.pi / 2), seg=32)
    b.lathe('paint', [(R + 0.0006, -0.012), (R + 0.0006, 0.012)], T(0, yc, 0, rx=math.pi / 2), seg=32)
    b.decal('decal', 0.06, TANK15, T(R + 0.0008, yc, 0.03, ry=math.pi / 2))
    b.decal('decal', 0.08, HAZARD, T(-R - 0.0008, yc, 0.0, ry=-math.pi / 2))
    b.cyl('plastic_dark', 0.014, 0.012, T(0, yc + R - 0.004, -0.083, rx=-0.9), seg=16)       # fill cap
    b.lathe('alu', [(0, 0), (0.013, 0), (0.013, 0.036), (0, 0.036)], T(-0.018, yc - 0.04, -0.105, rz=math.pi / 2), seg=16)
    b.rbox('plastic_dark', 0.03, 0.028, 0.03, 0.006, 0.002, T(0.008, yc - 0.04, -0.105))
    b.tube('rubber', [(0.008, yc - 0.055, -0.095), (0.0, yc - 0.062, -0.05), (0, yc - 0.062, 0.08), (0, yc - 0.05, 0.13)], 0.005, seg=10)
    b.rbox('plastic_dark', 0.03, 0.02, 0.022, 0.004, 0.002, T(0, yc - 0.04, 0.132))            # nozzle servo
    ang = 0.6
    b.lathe('alu', [(0, 0), (0.008, 0), (0.008, 0.012), (0.0065, 0.03), (0.004, 0.052), (0, 0.052)], T(0, yc - 0.052, 0.14, rx=math.pi / 2 + ang), seg=16)
    b.lathe('steel', [(0, 0.05), (0.0045, 0.05), (0.0038, 0.062), (0.0018, 0.064), (0, 0.064)], T(0, yc - 0.052, 0.14, rx=math.pi / 2 + ang), seg=12)


def payload_logistics(b):
    b.at('PAY_LOGISTICS', 'payload')
    yc = -0.128
    for z in (-0.07, 0.07):
        _rail_hanger(b, z, 0.034)
    b.rbox('plastic_dark', 0.12, 0.074, 0.18, 0.018, 0.008, T(0, yc, 0))
    b.rbox('paint', 0.1215, 0.02, 0.1815, 0.018, 0.002, T(0, yc + 0.012, 0))
    for z in (-0.05, 0.0, 0.05):
        b.rbox('plastic_dark', 0.123, 0.064, 0.008, 0.006, 0.002, T(0, yc - 0.002, z))       # ribs
    b.decal('decal', 0.07, TXT_LOGI, T(0.0618, yc - 0.012, 0.0, ry=math.pi / 2))
    b.decal('decal', 0.07, TXT_LOGI, T(-0.0618, yc - 0.012, 0.0, ry=-math.pi / 2))
    b.decal('decal', 0.06, CAUTION, T(0, yc - 0.012, 0.0915))
    for x in (-0.04, 0.04):
        b.rbox('steel', 0.012, 0.016, 0.004, 0.002, 0.001, T(x, yc + 0.02, 0.092))            # latches
    b.rbox('plastic_dark', 0.03, 0.018, 0.04, 0.004, 0.002, T(0, yc - 0.046, 0))             # release servo
    b.tube('steel', [(0, yc - 0.05, 0.006), (0, yc - 0.068, 0.006), (0, yc - 0.078, 0.0), (0, yc - 0.074, -0.01), (0, yc - 0.064, -0.012)], 0.0022, seg=8)
    b.lathe('steel', [(0.0075, -0.0015), (0.0105, -0.0015), (0.0105, 0.0015), (0.0075, 0.0015), (0.0075, -0.0015)], T(0, yc - 0.082, 0.0, rx=math.pi / 2), seg=18)


def payload_relay(b):
    b.at('PAY_RELAY', 'payload')
    # mesh radio: finned enclosure under the rails, twin down-tilted antennas
    yc = -0.066
    _rail_hanger(b, -0.02, 0.006, 0.08)
    _rail_hanger(b, 0.04, 0.006, 0.08)
    b.rbox('alu', 0.08, 0.026, 0.1, 0.006, 0.002, T(0, yc, 0.01))
    for k in range(9 if b.hi else 3):
        b.box('alu', 0.0015, 0.012, 0.094, T(-0.034 + k * (0.068 / (8 if b.hi else 2)), yc - 0.018, 0.01))
    b.decal('decal', 0.05, TXT_RELAY, T(0.0402, yc, 0.01, ry=math.pi / 2))
    for sx in (-1, 1):
        b.cyl('steel', 0.004, 0.006, T(sx * 0.03, yc - 0.008, 0.058, rx=math.pi / 2), seg=10)
        b.tube('plastic_dark', [(sx * 0.03, yc, 0.064), (sx * 0.05, yc - 0.1, 0.075)], 0.004, seg=10, radii=[0.0045, 0.003])
    # high-gain mast on the canopy
    b.at('PAY_RELAY', 'mast')
    b.cyl('plastic_dark', 0.011, 0.01, T(0, 0.072, 0.022), seg=16)
    b.tube('carbon', [(0, 0.08, 0.022), (0, 0.29, 0.022)], 0.0048, seg=12)
    b.lathe('paint', [(0.0056, 0.2), (0.0056, 0.215)], T(0, 0, 0.022), seg=16)
    b.lathe('plastic_light', [(0, 0.285), (0.0085, 0.285), (0.0085, 0.4), (0.006, 0.41), (0, 0.412)], T(0, 0, 0.022), seg=16)
    b.tube('alu', [(-0.07, 0.25, 0.022), (0.07, 0.25, 0.022)], 0.003, seg=8)
    for sx in (-1, 1):
        b.cyl('plastic_dark', 0.0045, 0.008, T(sx * 0.07, 0.247, 0.022), seg=10)
        b.cyl('plastic_dark', 0.0026, 0.075, T(sx * 0.07, 0.255, 0.022), seg=8, r2=0.0018)


def build_light(b):
    frame(b)
    canopy(b)
    avionics(b)
    battery(b)
    gear(b)
    motors(b)
    props(b)
    payload_scout(b)
    payload_suppression(b)
    payload_logistics(b)
    payload_relay(b)
