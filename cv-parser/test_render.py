import json
from jinja2 import Environment, FileSystemLoader

# Load first CV
with open('cv_database.json', 'r', encoding='utf-8') as f:
    db = json.load(f)

first_cv_id = list(db.keys())[0]
cv_data = db[first_cv_id]

env = Environment(loader=FileSystemLoader('templates'))

print("Rendering cv_detail.html...")
try:
    template = env.get_template('cv_detail.html')
    html = template.render(cv=cv_data)
    print("cv_detail.html rendered successfully!")
except Exception as e:
    import traceback
    traceback.print_exc()

print("\nRendering company_cv.html...")
try:
    template = env.get_template('company_cv.html')
    html = template.render(cv=cv_data)
    print("company_cv.html rendered successfully!")
except Exception as e:
    import traceback
    traceback.print_exc()
