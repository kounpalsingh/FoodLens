"""Build Food Lens data files from the Open Food Facts ingredient taxonomy.

Input : ingredients.txt from
        https://raw.githubusercontent.com/openfoodfacts/openfoodfacts-server/main/taxonomies/food/ingredients.txt
Output: data/off-animal-terms.json  (German + English names of every animal / maybe-animal ingredient, with its class)
        data/off-glossary-de-en.json (German name -> English name for every ingredient that has both)
Run   : python3 scripts/build-taxonomy.py path/to/ingredients.txt
"""
import json, re, sys
from collections import defaultdict

src = sys.argv[1]
blocks = open(src, encoding="utf-8").read().split("\n\n")

entries = []          # each: {names: {lang: [..]}, parents: [..], props: {..}}
index = {}            # "lang:name" -> entry idx
syn_re = re.compile(r"^([a-z]{2,3}|xx):\s*(.+)$")
prop_re = re.compile(r"^([a-z_]+):([a-z]{2}):\s*(.+)$")

def norm(s):
    return re.sub(r"\s+", " ", s.strip().lower().replace("-", " ").replace("_", " "))

for b in blocks:
    e = {"names": defaultdict(list), "parents": [], "props": {}}
    for line in b.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("synonyms:") or line.startswith("stopwords:"):
            continue
        if line.startswith("<"):
            e["parents"].append(norm(line[1:]))
            continue
        m = prop_re.match(line)
        if m:
            e["props"][m.group(1)] = m.group(3).strip()
            continue
        m = syn_re.match(line)
        if m:
            e["names"][m.group(1)] += [n.strip() for n in m.group(2).split(",") if n.strip()]
    if not e["names"]:
        continue
    i = len(entries)
    entries.append(e)
    for lang, names in e["names"].items():
        for n in names:
            index.setdefault(f"{lang}:{norm(n)}", i)

def parents_of(i):
    out = []
    for p in entries[i]["parents"]:
        j = index.get(p)
        if j is not None:
            out.append(j)
    return out

def inherited(i, prop, seen=None):
    seen = seen or set()
    if i in seen:
        return None
    seen.add(i)
    v = entries[i]["props"].get(prop)
    if v:
        return v.strip().lower()
    for j in parents_of(i):
        v = inherited(j, prop, seen)
        if v:
            return v
    return None

def descends(i, target, seen=None):
    seen = seen or set()
    if i == target:
        return True
    if i in seen:
        return False
    seen.add(i)
    return any(descends(j, target, seen) for j in parents_of(i))

EGG = index.get("en:egg")
FLAVOUR = [index.get(k) for k in ("en:flavouring", "en:natural flavouring", "en:aroma") if index.get(k) is not None]

TOO_GENERAL = {"cream", "creme", "crème", "rind"}  # "Creme" is used for vegan spreads; "Rind" also means rind/peel in English
terms = {}
counts = defaultdict(int)
for i, e in enumerate(entries):
    veg, vegan = inherited(i, "vegetarian"), inherited(i, "vegan")
    if any(descends(i, f) for f in FLAVOUR):
        continue  # flavourings: OFF marks them "maybe"; Food Lens deliberately ignores plain "Aroma"
    en_names = " ".join(e["names"].get("en", [])).lower()
    de_names = " ".join(e["names"].get("de", [])).lower()
    is_egg = (EGG is not None and descends(i, EGG)) or bool(re.search(r"\begg", en_names)) or bool(re.search(r"(^|\s)(ei|eier|eiern)\b|aus ei\b", de_names))
    if veg == "no":
        cls = "non_veg"
    elif veg == "maybe":
        cls = "maybe_non_veg"
    elif vegan == "no":
        cls = "egg" if is_egg else "animal_veg"
    elif vegan == "maybe":
        cls = "maybe_egg" if is_egg else "maybe_animal_veg"
    else:
        continue
    # "maybe" in OFF is applied to very general things (fat, bread, chocolate, cheese).
    # Food Lens keeps its own hand-picked "maybe" list, so only definite classes are imported.
    if cls.startswith("maybe"):
        continue
    for lang in ("de", "en", "xx"):
        for n in e["names"].get(lang, []):
            t = n.strip().lower()
            if len(t) < 3 or not re.search(r"[a-zäöüß]", t) or t in TOO_GENERAL:
                continue
            # stronger class wins if a name appears twice
            rank = ["maybe_animal_veg", "animal_veg", "maybe_egg", "egg", "maybe_non_veg", "non_veg"]
            if t not in terms or rank.index(cls) > rank.index(terms[t]):
                terms[t] = cls
    counts[cls] += 1

glossary = {}
for e in entries:
    de, en = e["names"].get("de"), e["names"].get("en")
    if de and en:
        for n in de:
            glossary.setdefault(n.strip().lower(), en[0].strip())

json.dump(dict(sorted(terms.items())), open("data/off-animal-terms.json", "w"), ensure_ascii=False, indent=0)
json.dump(dict(sorted(glossary.items())), open("data/off-glossary-de-en.json", "w"), ensure_ascii=False, indent=0)
print(f"{len(entries)} taxonomy entries")
print(f"animal/maybe ingredients by class: {dict(counts)}")
print(f"{len(terms)} German/English animal terms, {len(glossary)} German->English names")
