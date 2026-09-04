import requests

try:
    r = requests.get('http://127.0.0.1:5000/cv/5708b538-1ed5-48d2-97b3-31e6d4427a68')
    print("Status code:", r.status_code)
    with open('error.html', 'w', encoding='utf-8') as f:
        f.write(r.text)
    print("Saved response to error.html")
except Exception as e:
    print("Error fetching:", e)
