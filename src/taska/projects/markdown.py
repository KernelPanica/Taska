from markdown_it import MarkdownIt

# Disable raw HTML and unsafe URL schemes using the library's web-safe preset.
_parser = MarkdownIt("js-default").disable("image")


def render_markdown(text):
    return _parser.render(text)
