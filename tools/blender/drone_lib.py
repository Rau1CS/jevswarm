"""
Procedural mesh toolkit for the JEV drone models (run inside Blender).

All authoring happens in three.js conventions (metres, +Y up, +Z forward, +X port/left).
Vertices are converted to Blender space (x, -z, y) on output; the glTF exporter (+Y up)
converts them straight back, so the GLB is in the same frame the game uses.

Geometry is accumulated per (kit, part, material). Each bucket becomes one Blender
object named  KIT__part__material__lod  which the runtime groups by material for
instancing (live view) or by part (exploded TECH page view).
"""
import math
import bpy
import bmesh
from mathutils import Matrix, Vector

TAU = math.tau


def T(x=0.0, y=0.0, z=0.0, rx=0.0, ry=0.0, rz=0.0, s=1.0):
    """Translation * rotation (XYZ euler, radians) * uniform/tuple scale."""
    sc = s if isinstance(s, (tuple, list)) else (s, s, s)
    S = Matrix.Diagonal((sc[0], sc[1], sc[2], 1.0))
    R = Matrix.Rotation(rz, 4, 'Z') @ Matrix.Rotation(ry, 4, 'Y') @ Matrix.Rotation(rx, 4, 'X')
    return Matrix.Translation((x, y, z)) @ R @ S


def rrect(w, d, r, n, inset=0.0):
    """Rounded rectangle outline (x width, z depth) inset by `inset`; 4*(n+1) verts, CCW from +Y."""
    w2, d2 = w / 2 - inset, d / 2 - inset
    r = max(1e-4, min(r - inset if r > inset else 1e-4, w2, d2))
    pts = []
    for cx, cz, a0 in ((w2 - r, d2 - r, 0.0), (-(w2 - r), d2 - r, 0.25), (-(w2 - r), -(d2 - r), 0.5), (w2 - r, -(d2 - r), 0.75)):
        for k in range(n + 1):
            a = (a0 + 0.25 * k / max(1, n)) * TAU
            pts.append((cx + r * math.cos(a), cz + r * math.sin(a)))
    return pts[::-1]


def bevel_profile(h, b, n, top=True, bottom=True):
    """(inset, y) pairs for a slab of height h with quarter-round bevel b on its edges."""
    if n == 0 or b <= 0:
        return [(0.0, 0.0), (0.0, h)]
    out = []
    if bottom:
        out += [(b - b * math.sin(a), b - b * math.cos(a)) for a in (i / n * TAU / 4 for i in range(n + 1))]
    else:
        out.append((0.0, 0.0))
    if top:
        out += [(b - b * math.cos(a), h - b + b * math.sin(a)) for a in (i / n * TAU / 4 for i in range(n + 1))]
    else:
        out.append((0.0, h))
    return out


class Builder:
    def __init__(self, lod):
        self.lod = lod
        self.buckets = {}
        self.cutters = {}
        self.cutmode = False
        self.kit = 'KIT'
        self.part = 'part'

    # ---- configuration -------------------------------------------------------------
    @property
    def hi(self):
        return self.lod == 0

    def seg(self, n):
        return n if self.lod == 0 else max(6, n // 3)

    def at(self, kit, part):
        self.kit, self.part = kit, part
        return self

    def _bucket(self, mat):
        return self.buckets.setdefault((self.kit, self.part, mat), {'v': [], 'f': [], 'uv': []})

    # ---- core emit -----------------------------------------------------------------
    def emit(self, mat, verts, faces, M=Matrix.Identity(4), uvs=None, closed=False, cut=False):
        """Append a primitive. uvs: per-face list of per-corner (u, v); None -> box projection."""
        wv = [M @ Vector(v) for v in verts]
        faces = [list(f) for f in faces]
        if closed:
            vol = 0.0
            for f in faces:
                for k in range(1, len(f) - 1):
                    vol += wv[f[0]].dot(wv[f[k]].cross(wv[f[k + 1]]))
            if vol < 0:
                faces = [f[::-1] for f in faces]
                uvs = [u[::-1] for u in uvs] if uvs else None
        elif M.determinant() < 0:
            faces = [f[::-1] for f in faces]
            uvs = [u[::-1] for u in uvs] if uvs else None
        if cut or self.cutmode:
            b = self.cutters.setdefault((self.kit, self.part, mat), {'v': [], 'f': [], 'uv': []})
        else:
            b = self._bucket(mat)
        base = len(b['v'])
        b['v'].extend(wv)
        for i, f in enumerate(faces):
            b['f'].append([base + j for j in f])
            b['uv'].append(uvs[i] if uvs else box_uv([wv[j] for j in f]))

    # ---- primitives (local frame, then placed by M) ---------------------------------
    def lathe(self, mat, profile, M=Matrix.Identity(4), seg=24, a0=0.0, a1=TAU, cut=False):
        """Revolve (r, y) profile about +Y. Profile runs bottom->top for outward normals."""
        seg = self.seg(seg)
        full = abs(a1 - a0 - TAU) < 1e-6
        ncol = seg if full else seg + 1
        verts, rings, uvs, faces = [], [], [], []
        rref = max(p[0] for p in profile) or 1e-3
        vacc = [0.0]
        for i in range(1, len(profile)):
            vacc.append(vacc[-1] + math.dist(profile[i], profile[i - 1]))
        for r, y in profile:
            if r < 1e-7:
                rings.append([len(verts)] * ncol)
                verts.append((0.0, y, 0.0))
                continue
            ring = []
            for j in range(ncol):
                a = a0 + (a1 - a0) * j / seg
                ring.append(len(verts))
                verts.append((r * math.sin(a), y, r * math.cos(a)))
            rings.append(ring)
        for i in range(len(rings) - 1):
            for j in range(seg):
                j2 = (j + 1) % ncol if full else j + 1
                q = [rings[i][j], rings[i][j2], rings[i + 1][j2], rings[i + 1][j]]
                uq = [(j / seg * rref * TAU, vacc[i]), ((j + 1) / seg * rref * TAU, vacc[i]),
                      ((j + 1) / seg * rref * TAU, vacc[i + 1]), (j / seg * rref * TAU, vacc[i + 1])]
                keep = [k for k in range(4) if k == 0 or q[k] != q[k - 1]]
                if q[keep[-1]] == q[keep[0]] and len(keep) > 1:
                    keep.pop()
                if len(keep) >= 3:
                    faces.append([q[k] for k in keep])
                    uvs.append([uq[k] for k in keep])
        closed = full and profile[0][0] < 1e-7 and profile[-1][0] < 1e-7
        self.emit(mat, verts, faces, M, uvs, closed=closed, cut=cut)

    def cyl(self, mat, r, h, M=Matrix.Identity(4), seg=24, r2=None, cut=False):
        """Capped cylinder/cone along +Y from y=0 to y=h."""
        r2 = r if r2 is None else r2
        self.lathe(mat, [(0, 0), (r, 0), (r2, h), (0, h)], M, seg, cut=cut)

    def sphere(self, mat, r, M=Matrix.Identity(4), seg=20, a0=-TAU / 4, a1=TAU / 4):
        n = max(3, self.seg(seg) // 2)
        prof = [(r * math.cos(a0 + (a1 - a0) * i / n), r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]
        prof = [(max(0.0, p[0]) if abs(p[0]) > 1e-7 else 0.0, p[1]) for p in prof]
        if prof[0][0] > 0:
            prof.insert(0, (0.0, prof[0][1]))
        if prof[-1][0] > 0:
            prof.append((0.0, prof[-1][1]))
        self.lathe(mat, prof, M, seg)

    def box(self, mat, sx, sy, sz, M=Matrix.Identity(4), cut=False):
        x, y, z = sx / 2, sy / 2, sz / 2
        v = [(-x, -y, -z), (x, -y, -z), (x, y, -z), (-x, y, -z), (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z)]
        f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (1, 2, 6, 5), (0, 4, 7, 3)]
        self.emit(mat, v, f, M, closed=True, cut=cut)

    def slab(self, mat, outline_fn, profile, M=Matrix.Identity(4)):
        """Loft an outline (callable inset -> [(x, z)]) through (inset, y) profile; capped."""
        rings = [[(x, y, z) for x, z in outline_fn(ins)] for ins, y in profile]
        self.loft(mat, rings, M, cap0=True, cap1=True)

    def rbox(self, mat, w, h, d, r=0.004, bev=0.002, M=Matrix.Identity(4), n=3):
        """Rounded box centred on origin: corner radius r (plan), edge bevel bev."""
        n = n if self.hi else 1
        prof = [(i, y - h / 2) for i, y in bevel_profile(h, bev, n if self.hi else 0)]
        self.slab(mat, lambda ins: rrect(w, d, r, n, ins), prof, M)

    def loft(self, mat, rings, M=Matrix.Identity(4), cap0=True, cap1=True, uv_len=None):
        """Connect closed rings (equal vertex count) in order; optional fan caps."""
        n = len(rings[0])
        verts, faces, uvs = [], [], []
        per = sum(math.dist(rings[0][j], rings[0][(j + 1) % n]) for j in range(n))
        v = [0.0]
        for i in range(1, len(rings)):
            c0 = sum((Vector(p) for p in rings[i - 1]), Vector()) / n
            c1 = sum((Vector(p) for p in rings[i]), Vector()) / n
            v.append(v[-1] + (c1 - c0).length)
        for ring in rings:
            verts.extend(ring)
        for i in range(len(rings) - 1):
            for j in range(n):
                j2 = (j + 1) % n
                faces.append([i * n + j, i * n + j2, (i + 1) * n + j2, (i + 1) * n + j])
                u0, u1 = j / n * per, (j + 1) / n * per
                uvs.append([(u0, v[i]), (u1, v[i]), (u1, v[i + 1]), (u0, v[i + 1])])
        for cap, idx, rev in ((cap0, 0, True), (cap1, len(rings) - 1, False)):
            if not cap:
                continue
            c = sum((Vector(p) for p in rings[idx]), Vector()) / n
            ci = len(verts)
            verts.append(tuple(c))
            for j in range(n):
                tri = [ci, idx * n + j, idx * n + (j + 1) % n]
                faces.append(tri[::-1] if rev else tri)
                uvs.append(None)
        # fill None uvs with planar box mapping later
        wv = [M @ Vector(p) for p in verts]
        uvs = [u if u is not None else box_uv([wv[k] for k in f]) for u, f in zip(uvs, faces)]
        self.emit(mat, verts, faces, M, uvs, closed=cap0 and cap1)

    def tube(self, mat, pts, r, M=Matrix.Identity(4), seg=12, caps=True, radii=None):
        """Sweep a circle along a polyline (parallel-transport frames)."""
        seg = self.seg(seg)
        P = [Vector(p) for p in pts]
        tangents = []
        for i in range(len(P)):
            a = P[max(0, i - 1)]
            b = P[min(len(P) - 1, i + 1)]
            tangents.append((b - a).normalized())
        up = Vector((0, 1, 0)) if abs(tangents[0].y) < 0.9 else Vector((1, 0, 0))
        nrm = tangents[0].cross(up).normalized()
        rings = []
        for i, p in enumerate(P):
            if i > 0:
                axis = tangents[i - 1].cross(tangents[i])
                if axis.length > 1e-8:
                    ang = tangents[i - 1].angle(tangents[i])
                    nrm = (Matrix.Rotation(ang, 3, axis.normalized()) @ nrm).normalized()
            bin_ = tangents[i].cross(nrm).normalized()
            rr = radii[i] if radii else r
            rings.append([tuple(p + (nrm * math.cos(a) + bin_ * math.sin(a)) * rr) for a in (j / seg * TAU for j in range(seg))])
        self.loft(mat, rings, M, cap0=caps, cap1=caps)

    def decal(self, mat, w, cell, M=Matrix.Identity(4), grid=4):
        """Quad in local XY plane facing +Z (text reads along +X); height from the cell aspect.
        UVs map atlas cell (col, row-from-top) - see DECAL_ASPECT, shared with the runtime atlas."""
        if not self.hi:
            return
        c, r = cell
        h = w / DECAL_ASPECT.get(cell, 1.0)
        u0, u1 = c / grid, (c + 1) / grid
        v0, v1 = 1 - (r + 1) / grid, 1 - r / grid
        v = [(-w / 2, -h / 2, 0), (w / 2, -h / 2, 0), (w / 2, h / 2, 0), (-w / 2, h / 2, 0)]
        self.emit(mat, v, [(0, 1, 2, 3)], M, [[(u0, v0), (u1, v0), (u1, v1), (u0, v1)]])


# Decal atlas cells (col, row-from-top) -> width/height aspect. Mirrors src/render/drone/textures.ts.
DECAL_ASPECT = {
    (0, 0): 4, (1, 0): 2, (2, 0): 4, (3, 0): 4,
    (0, 1): 4, (1, 1): 4, (2, 1): 3, (3, 1): 1,
    (0, 2): 4, (1, 2): 3, (2, 2): 0.5, (3, 2): 3,
    (0, 3): 4, (1, 3): 4, (2, 3): 3, (3, 3): 2,
}
HAZARD, JEV, TXT_SCOUT, TXT_SUPP = (0, 0), (1, 0), (2, 0), (3, 0)
TXT_LOGI, TXT_RELAY, LIPO, ARROW = (0, 1), (1, 1), (2, 1), (3, 1)
CAUTION, SMARTBAT, LEVEL, NOSTEP = (0, 2), (1, 2), (2, 2), (3, 2)
SUPPRESSANT, HEAVYLIFT, IDPLATE, TANK15 = (0, 3), (1, 3), (2, 3), (3, 3)


def box_uv(pts):
    """Per-face planar projection on the dominant axis, 1 UV unit = 1 metre."""
    n = Vector()
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        n.x += (a.y - b.y) * (a.z + b.z)
        n.y += (a.z - b.z) * (a.x + b.x)
        n.z += (a.x - b.x) * (a.y + b.y)
    ax = max(range(3), key=lambda k: abs(n[k]))
    if ax == 0:
        return [(p.z, p.y) for p in pts]
    if ax == 1:
        return [(p.x, p.z) for p in pts]
    return [(p.x, p.y) for p in pts]


# ---- Blender object output -------------------------------------------------------------

MATCOL = {
    'carbon': (0.02, 0.02, 0.022, 1), 'paint': (0.75, 0.2, 0.12, 1), 'anod': (0.6, 0.15, 0.1, 1),
    'alu': (0.12, 0.12, 0.13, 1), 'steel': (0.7, 0.7, 0.72, 1), 'copper': (0.72, 0.4, 0.18, 1),
    'plastic_dark': (0.04, 0.04, 0.045, 1), 'plastic_light': (0.8, 0.8, 0.78, 1), 'rubber': (0.015, 0.015, 0.015, 1),
    'glass': (0.02, 0.03, 0.06, 1), 'germanium': (0.08, 0.08, 0.09, 1), 'prop': (0.03, 0.03, 0.03, 1),
    'battery': (0.06, 0.08, 0.12, 1), 'tank': (0.85, 0.85, 0.8, 1), 'decal': (1, 1, 1, 1),
    'wire_red': (0.6, 0.03, 0.02, 1), 'pcb': (0.05, 0.2, 0.12, 1), 'led': (0.2, 1.0, 0.4, 1),
}


def get_mat(name):
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
        m.diffuse_color = MATCOL.get(name, (0.5, 0.5, 0.5, 1))
    return m


def _to_blender(v):
    return (v.x, -v.z, v.y)


def _make_mesh(name, data):
    me = bpy.data.meshes.new(name)
    me.from_pydata([_to_blender(v) for v in data['v']], [], data['f'])
    me.validate(clean_customdata=False)
    uvl = me.uv_layers.new(name='UVMap')
    li = 0
    for poly, fuv in zip(me.polygons, data['uv']):
        for k in range(poly.loop_total):
            uvl.data[poly.loop_start + k].uv = fuv[k]
        li += poly.loop_total
    return me


def _smooth(me, angle):
    me.shade_smooth()
    me.set_sharp_from_angle(angle=angle)


def box_uv_mesh(me):
    uvl = me.uv_layers.active or me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        pts = [Vector((me.vertices[vi].co.x, me.vertices[vi].co.z, -me.vertices[vi].co.y)) for vi in poly.vertices]
        for k, uv in enumerate(box_uv(pts)):
            uvl.data[poly.loop_start + k].uv = uv


def build_objects(b, collection):
    objs = []
    for (kit, part, mat), data in b.buckets.items():
        if not data['f']:
            continue
        name = f'{kit}__{part}__{mat}__{b.lod}'
        me = _make_mesh(name, data)
        ob = bpy.data.objects.new(name, me)
        collection.objects.link(ob)
        ob.data.materials.append(get_mat(mat))
        cut = b.cutters.get((kit, part, mat))
        if cut and cut['f']:
            cme = _make_mesh(name + '_cut', cut)
            cob = bpy.data.objects.new(name + '_cut', cme)
            collection.objects.link(cob)
            mod = ob.modifiers.new('cut', 'BOOLEAN')
            mod.operation, mod.solver, mod.object = 'DIFFERENCE', 'EXACT', cob
            dg = bpy.context.evaluated_depsgraph_get()
            nm = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
            ob.modifiers.clear()
            ob.data = nm
            bpy.data.objects.remove(cob)
            box_uv_mesh(nm)
        _smooth(ob.data, math.radians(40 if b.lod == 0 else 55))
        objs.append(ob)
    return objs
