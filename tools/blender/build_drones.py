"""
Build the JEV drone GLB:  blender -b --factory-startup --python tools/blender/build_drones.py -- [--preview DIR]

Writes public/models/jev_drones.glb with objects named KIT__part__material__lod (lod 0 = close-up
detail, lod 1 = distance/fleet). Materials are applied at runtime (src/render/drone/materials.ts),
so the GLB carries geometry + UVs only. --preview renders EEVEE check images.
"""
import os
import sys
import math
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import drone_lib, drone_common, drone_light, drone_heavy  # noqa: E402
import importlib
for m in (drone_lib, drone_common, drone_light, drone_heavy):
    importlib.reload(m)
from drone_lib import Builder, build_objects, MATCOL  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'public', 'models', 'jev_drones.glb')
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
PREVIEW = argv[argv.index('--preview') + 1] if '--preview' in argv else None
DRACO = '--no-draco' not in argv
ONLY = argv[argv.index('--only') + 1].split(',') if '--only' in argv else None


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def build():
    col = bpy.context.scene.collection
    objs = []
    for lod in (0, 1):
        b = Builder(lod)
        drone_light.build_light(b)
        drone_heavy.build_heavy(b)
        objs += build_objects(b, col)
    return objs


def export(objs):
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    for o in bpy.context.scene.objects:
        o.select_set(o in objs)
    bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_apply=False,
                              export_yup=True, export_normals=True, export_texcoords=True, export_tangents=False,
                              export_materials='NONE', export_vertex_color='NONE', export_animations=False,
                              export_draco_mesh_compression_enable=DRACO, export_draco_mesh_compression_level=7,
                              export_draco_position_quantization=16, export_draco_normal_quantization=10,
                              export_draco_texcoord_quantization=14)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)
    print(f'EXPORTED {OUT}  objects={len(objs)} tris={tris} bytes={os.path.getsize(OUT)}')
    for lod in (0, 1):
        per = {}
        for o in objs:
            kit, _, _, l = o.name.split('__')
            if int(l) == lod:
                per[kit] = per.get(kit, 0) + sum(len(p.vertices) - 2 for p in o.data.polygons)
        print(f'  lod{lod} tris per kit: {per}')


def preview(objs, outdir):
    os.makedirs(outdir, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = 1280, 900
    sc.render.film_transparent = False
    world = bpy.data.worlds.new('w')
    sc.world = world
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (0.35, 0.38, 0.42, 1)
    world.node_tree.nodes['Background'].inputs[1].default_value = 0.8
    for name, c in MATCOL.items():
        m = bpy.data.materials.get(name)
        if not m:
            continue
        m.use_nodes = True
        bsdf = m.node_tree.nodes.get('Principled BSDF')
        bsdf.inputs['Base Color'].default_value = c
        metal = name in ('alu', 'steel', 'copper', 'anod')
        bsdf.inputs['Metallic'].default_value = 1.0 if metal else 0.0
        bsdf.inputs['Roughness'].default_value = 0.35 if metal else (0.15 if name in ('glass', 'germanium') else 0.55)
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 4
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    sc.collection.objects.link(cam)
    sc.camera = cam
    shots = {
        'light_supp': (['LIGHT', 'PROP_L_CCW', 'PAY_SUPPRESSION'], 0.9),
        'light_scout': (['LIGHT', 'PAY_SCOUT'], 0.9),
        'light_logi': (['LIGHT', 'PAY_LOGISTICS'], 0.9),
        'light_relay': (['LIGHT', 'PAY_RELAY'], 1.0),
        'heavy': (['HEAVY', 'PROP_H_CCW'], 3.4),
        'prop': (['PROP_L_CCW'], 0.28),
    }
    from mathutils import Vector
    for shot, (kits, dist) in shots.items():
        if ONLY and shot not in ONLY:
            continue
        for o in objs:
            kit, _, _, lod = o.name.split('__')
            o.hide_render = not (kit in kits and lod == '0')
        tgt = Vector((0, 0, 0.0))
        cam.location = tgt + Vector((dist * 0.75, -dist * 0.85, dist * 0.45))
        d = tgt - cam.location
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = os.path.join(outdir, f'{shot}.png')
        bpy.ops.render.render(write_still=True)
        print('RENDERED', sc.render.filepath)


reset()
objs = build()
export(objs)
if PREVIEW:
    preview(objs, PREVIEW)
