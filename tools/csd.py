"""Bounded reader for the version-3 Ninja CSD layout used by these menu assets.

Format references: hedge-dev/SharpNeedle (MIT-0), Framework/Ninja/Csd,
and TGE's sonic_xncp_yncp.bt. No game data is embedded in this module.
The optional aspect-ratio correction graph is retained as an unsupported feature;
this viewer targets the original scene aspect ratio.
"""
import math
import struct


class CsdReader:
    def __init__(self, data):
        self.data = data
        self.base = 0
        self.endian = ">"

    def read(self, fmt, offset):
        size = struct.calcsize(self.endian + fmt)
        if offset < 0 or offset + size > len(self.data):
            raise ValueError("CSD read outside resource")
        return struct.unpack_from(self.endian + fmt, self.data, offset)

    def u(self, offset):
        return self.read("I", offset)[0]

    def f(self, offset):
        value = self.read("f", offset)[0]
        if not math.isfinite(value):
            raise ValueError("CSD has non-finite float")
        return value

    def ptr(self, offset):
        relative = self.u(offset)
        result = self.base + relative if relative else 0
        if result >= len(self.data):
            raise ValueError("CSD offset outside resource")
        return result

    def string(self, offset):
        if not offset:
            return None
        end = self.data.find(b"\0", offset, min(offset + 4096, len(self.data)))
        if end < 0:
            raise ValueError("CSD string is not terminated")
        raw = self.data[offset:end]
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return raw.decode("shift_jis")

    def count(self, offset, maximum=65536):
        n = self.u(offset)
        if n > maximum:
            raise ValueError("CSD count exceeds limit")
        return n

    def rgba(self, offset):
        value = self.u(offset)
        return [(value >> shift & 255) / 255 for shift in (24, 16, 8, 0)]

    def cast(self, p):
        if not p:
            raise ValueError("Null CSD cast")
        info = self.ptr(p + 0x30)
        indices = self.ptr(p + 0x40)
        if not info or not indices:
            raise ValueError("Missing cast info or material")
        return {
            "type": self.u(p + 4), "enabled": bool(self.u(p + 8)),
            "mask": self.u(p + 0x2c),
            "corners": [list(self.read("ff", p + off)) for off in (12, 20, 28, 36)],
            "inherit": self.u(p + 0x34), "material": self.u(p + 0x38),
            "indices": list(self.read(f"{self.count(p + 0x3c, 256)}i", indices)),
            "text": self.string(self.ptr(p + 0x44)),
            "font": self.string(self.ptr(p + 0x48)), "kerning": self.f(p + 0x4c),
            "origin": list(self.read("ff", p + 0x60)),
            "position": list(self.read("ff", p + 0x68)),
            "info": {"hidden": self.u(info), "translation": list(self.read("ff", info + 4)),
                     "rotation": self.f(info + 12), "scale": list(self.read("ff", info + 16)),
                     "sprite": self.f(info + 24), "color": self.rgba(info + 28),
                     "gradients": [self.rgba(info + off) for off in (32, 36, 40, 44)]},
        }

    def group(self, p):
        n = self.count(p, 4096)
        table, tree = self.ptr(p + 4), self.ptr(p + 12)
        casts = [self.cast(self.ptr(table + i * 4)) for i in range(n)]
        parents = [-1] * n
        visited = set()

        def visit(index, parent):
            while index != -1:
                if not 0 <= index < n or index in visited:
                    raise ValueError("Invalid or cyclic CSD hierarchy")
                visited.add(index)
                parents[index] = parent
                child, sibling = self.read("ii", tree + index * 8)
                if child != -1:
                    visit(child, index)
                index = sibling

        if n:
            visit(self.read("i", p + 8)[0], -1)
        if len(visited) != n:
            raise ValueError("Unreachable CSD casts")
        return {"casts": casts, "parents": parents}

    def motion(self, p, name, start, end, groups):
        tracks = []
        ng, gt = self.count(p, 1024), self.ptr(p + 4)
        if ng != len(groups):
            raise ValueError("CSD motion/group count mismatch")
        for gi in range(ng):
            gp = gt + gi * 8
            nc, ct = self.count(gp, 4096), self.ptr(gp + 4)
            if nc != len(groups[gi]["casts"]):
                raise ValueError("CSD motion/cast count mismatch")
            for ci in range(nc):
                cp = ct + ci * 8
                flags, pt = self.u(cp), self.ptr(cp + 4)
                if flags >> 12:
                    raise ValueError("Unknown CSD animated property")
                pi = 0
                for bit in range(12):
                    if not flags & (1 << bit):
                        continue
                    tp = pt + pi * 12
                    nk, kt = self.count(tp + 4, 65536), self.ptr(tp + 8)
                    keys = []
                    for ki in range(nk):
                        kp = kt + ki * 24
                        value = self.u(kp + 4) if bit == 0 else self.rgba(kp + 4) if bit >= 7 else self.f(kp + 4)
                        keys.append([self.read("i", kp)[0], value, self.u(kp + 8), self.f(kp + 12), self.f(kp + 16)])
                    if any(a[0] > b[0] for a, b in zip(keys, keys[1:])):
                        raise ValueError(f"Unsorted CSD keyframes: {name}, {gi}, {ci}, {bit}, {[k[0] for k in keys]}")
                    tracks.append({"group": gi, "cast": ci, "property": bit, "keys": keys})
                    pi += 1
        return {"name": name, "start": start, "end": end, "tracks": tracks}

    def scene(self, p, name):
        if self.u(p) != 3:
            raise ValueError("Only version-3 CSD scenes are supported")
        ns, st = self.count(p + 0x1c), self.ptr(p + 0x20)
        sprites = [{"texture": self.u(st + i * 20), "uv": list(self.read("ffff", st + i * 20 + 4))} for i in range(ns)]
        ng, gt = self.count(p + 0x24, 1024), self.ptr(p + 0x28)
        groups = [self.group(gt + i * 16) for i in range(ng)]
        nd, dt = self.count(p + 0x2c), self.ptr(p + 0x30)
        for i in range(nd):
            dp = dt + i * 12
            gi, ci = self.read("II", dp + 4)
            groups[gi]["casts"][ci]["name"] = self.string(self.ptr(dp))
        nm, mt, md, mf = self.count(p + 0x34, 256), self.ptr(p + 0x38), self.ptr(p + 0x3c), self.ptr(p + 0x44)
        names = {}
        for i in range(nm):
            names[self.u(md + i * 8 + 4)] = self.string(self.ptr(md + i * 8))
        motions = [self.motion(mt + i * 8, names[i], self.f(mf + i * 8), self.f(mf + i * 8 + 4), groups) for i in range(nm)]
        return {"name": name, "priority": self.f(p + 4), "fps": self.f(p + 8),
                "aspect": self.f(p + 0x40), "sprites": sprites, "groups": groups,
                "motions": motions, "aspect_corrections_supported": False}

    def parse(self):
        if self.data[:4] != b"CPAF":
            raise ValueError("Expected CPAF menu container")
        first_size = self.u(4)
        r1 = 8 + first_size
        if self.data[8:12] != b"NYIF" or self.data[40:44] != b"nCPJ":
            raise ValueError("Expected big-endian Ninja CSD project")
        project_end = 48 + struct.unpack_from("<I", self.data, 44)[0]
        if project_end > r1 or self.data[64:68] != b".DXL":
            raise ValueError("Invalid CSD project chunk")
        self.base = 40
        root = self.ptr(56)
        n, st, ids = self.count(root, 256), self.ptr(root + 4), self.ptr(root + 8)
        names = {self.u(ids + i * 8 + 4): self.string(self.ptr(ids + i * 8)) for i in range(n)}
        scenes = [self.scene(self.ptr(st + i * 4), names[i]) for i in range(n)]
        fonts = {}
        ft = self.ptr(68)
        nf, fd, fi = self.count(ft, 256), self.ptr(ft + 4), self.ptr(ft + 8)
        for i in range(nf):
            index = self.u(fi + i * 8 + 4)
            nc, chars = self.count(fd + index * 8, 256), self.ptr(fd + index * 8 + 4)
            fonts[self.string(self.ptr(fi + i * 8))] = {chr(self.data[chars + c * 8]): self.u(chars + c * 8 + 4) for c in range(nc)}
        # Resource 1 stores names of the original DDS atlases.
        if self.data[r1 + 4:r1 + 8] != b"NYIF" or self.data[r1 + 36:r1 + 40] != b"NXTL":
            raise ValueError("Missing CSD texture resource")
        self.base = r1 + 36
        tl = self.ptr(self.base + 8)
        nt, tt = self.count(tl, 256), self.ptr(tl + 4)
        textures = [self.string(self.ptr(tt + i * 8)) for i in range(nt)]
        for scene in scenes:
            if any(s["texture"] >= nt for s in scene["sprites"]):
                raise ValueError("CSD sprite references missing texture")
        return {"format": "ninja-csd-v3", "textures": textures, "scenes": scenes, "fonts": fonts}


def parse_csd(data):
    return CsdReader(data).parse()
