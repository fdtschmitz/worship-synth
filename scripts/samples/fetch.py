import sys, os, zipfile
sys.path.insert(0, os.path.dirname(__file__))
from httpzip import open_zip
out = sys.argv[1]
z = open_zip()
for name in sys.argv[2:]:
    data = z.read(name)
    inner = zipfile.ZipFile(__import__("io").BytesIO(data))
    dest = os.path.join(out, name.replace(".xrni", ""))
    os.makedirs(dest, exist_ok=True)
    for i in inner.infolist():
        if i.is_dir(): continue
        target = os.path.realpath(os.path.join(dest, i.filename))
        if not target.startswith(os.path.realpath(dest)): continue  # protege contra path traversal
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as f: f.write(inner.read(i))
    print(name, len(inner.infolist()), "arquivos")
