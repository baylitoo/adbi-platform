# Documentation de la plateforme ADBI (Sphinx, thème Furo).
project = "Plateforme ADBI"
author = "ADBI"
copyright = "2026, ADBI"
language = "fr"

extensions = [
    "sphinx.ext.autosectionlabel",
    "sphinxcontrib.mermaid",
    "sphinx_copybutton",
]
autosectionlabel_prefix_document = True
exclude_patterns = ["_build"]

html_theme = "furo"
html_title = "Plateforme ADBI"
html_static_path = ["_static"]
html_css_files = ["adbi.css"]
html_theme_options = {
    "sidebar_hide_name": False,
    "navigation_with_keys": True,
    "light_css_variables": {
        "color-brand-primary": "#C8102E",
        "color-brand-content": "#0F2042",
        "color-admonition-background": "#FDECEF",
        "font-stack": "Poppins, system-ui, -apple-system, 'Segoe UI', sans-serif",
    },
    "dark_css_variables": {
        "color-brand-primary": "#FF5470",
        "color-brand-content": "#E6EAF2",
    },
}

mermaid_version = "11.4.1"
mermaid_init_config = {"startOnLoad": False, "securityLevel": "strict"}
mermaid_light_theme = "neutral"
mermaid_dark_theme = "dark"
mermaid_height = "auto"
copybutton_prompt_text = r"\$ "
copybutton_prompt_is_regexp = True
