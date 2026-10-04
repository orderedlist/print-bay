"""
parts3mf.py - pack separately rendered parts into one OrcaSlicer object, one filament per part.

OrcaSlicer only gives different parts different filaments when they are parts
(volumes) of a single object, which is how its own 3MF projects store them: each
part is a mesh object, a parent object lists them as components, and
Metadata/model_settings.config gives each part its extruder. The parts keep their
rendered coordinates relative to each other; the whole object goes to the middle
of the bed.
"""
import struct
import zipfile
from pathlib import Path

BED = 260  # mm, the K2's printable area is 0..260 in X and Y


def read_stl(path):
    """Vertices and triangles of a binary or ASCII STL, with shared vertices merged."""
    data = Path(path).read_bytes()
    corners = []
    if data[:5] == b"solid" and b"facet" in data[:1024]:
        for line in data.decode(errors="replace").splitlines():
            parts = line.split()
            if parts[:1] == ["vertex"]:
                corners.append(tuple(float(x) for x in parts[1:4]))
    else:
        (n,) = struct.unpack_from("<I", data, 80)
        for i in range(n):
            o = 84 + i * 50 + 12
            for k in range(3):
                corners.append(struct.unpack_from("<3f", data, o + 12 * k))
    index, verts, tris = {}, [], []
    for i in range(0, len(corners), 3):
        tri = []
        for v in corners[i:i + 3]:
            key = tuple(round(c, 5) for c in v)
            if key not in index:
                index[key] = len(verts)
                verts.append(key)
            tri.append(index[key])
        if len(set(tri)) == 3:
            tris.append(tri)
    return verts, tris


def mesh_xml(verts, tris, dx, dy, dz):
    v = "".join(f'<vertex x="{x + dx:.5f}" y="{y + dy:.5f}" z="{z + dz:.5f}"/>' for x, y, z in verts)
    t = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in tris)
    return f"<mesh><vertices>{v}</vertices><triangles>{t}</triangles></mesh>"


def write(parts, dest, name="model"):
    """parts: [(part name, stl path, extruder number from 1)] -> a 3MF at dest."""
    meshes = [(pname, *read_stl(stl), extruder) for pname, stl, extruder in parts]
    xs = [v[0] for _, verts, _, _ in meshes for v in verts]
    ys = [v[1] for _, verts, _, _ in meshes for v in verts]
    zs = [v[2] for _, verts, _, _ in meshes for v in verts]
    # centre the parts as a group on the origin, sitting on z = 0; the build item moves it to the bed centre
    dx, dy, dz = -(min(xs) + max(xs)) / 2, -(min(ys) + max(ys)) / 2, -min(zs)

    parent = len(meshes) + 1
    objects = "".join(
        f'<object id="{i}" type="model">{mesh_xml(verts, tris, dx, dy, dz)}</object>'
        for i, (_, verts, tris, _) in enumerate(meshes, 1))
    components = "".join(f'<component objectid="{i}"/>' for i in range(1, parent))
    model = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
        f'<resources>{objects}<object id="{parent}" type="model"><components>{components}</components></object></resources>'
        f'<build><item objectid="{parent}" transform="1 0 0 0 1 0 0 0 1 {BED / 2} {BED / 2} 0" printable="1"/></build>'
        "</model>")
    settings = (
        '<?xml version="1.0" encoding="UTF-8"?><config>'
        f'<object id="{parent}"><metadata key="name" value="{name}"/><metadata key="extruder" value="{meshes[0][3]}"/>'
        + "".join(
            f'<part id="{i}" subtype="normal_part"><metadata key="name" value="{pname}"/>'
            f'<metadata key="extruder" value="{extruder}"/></part>'
            for i, (pname, _, _, extruder) in enumerate(meshes, 1))
        + "</object></config>")
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
        z.writestr("_rels/.rels",
                   '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
        z.writestr("3D/3dmodel.model", model)
        z.writestr("Metadata/model_settings.config", settings)
    return dest
