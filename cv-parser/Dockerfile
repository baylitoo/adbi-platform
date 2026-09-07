# CV Parser : client DocIE et exports, sans runtime OCR/ML local.
FROM python:3.14-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

ENV PYTHONUNBUFFERED=1
ENV ADBI_HOTE=0.0.0.0
EXPOSE 5000

RUN useradd -r -u 1000 -m -d /home/adbi adbi \
    && mkdir -p /app/data /app/uploads /app/cv_output \
    && chown -R adbi:adbi /app /home/adbi
USER adbi

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','5000')+'/api/sante', timeout=4)" || exit 1

CMD ["gunicorn", "-c", "gunicorn.conf.py", "app:app"]
