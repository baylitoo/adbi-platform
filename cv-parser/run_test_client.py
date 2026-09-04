from app import app
import traceback

with open('test_output.txt', 'w', encoding='utf-8') as out_f:
    out_f.write("Starting test client...\n")
    try:
        client = app.test_client()
        response = client.get('/cv/5708b538-1ed5-48d2-97b3-31e6d4427a68')
        out_f.write(f"Status: {response.status_code}\n")
        out_f.write("Response text:\n")
        out_f.write(response.get_data(as_text=True))
    except Exception as e:
        out_f.write("Test client threw an exception:\n")
        traceback.print_exc(file=out_f)

