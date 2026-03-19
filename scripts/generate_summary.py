import os
import re

def generate_summary():
    patch_files = sorted([f for f in os.listdir('.') if f.startswith('patch-') and f.endswith('.md')])
    
    summary = """# SCX Patch Study

This document provides a summary and index of the `sched_ext` patch series.

## Patches

"""

    for patch_file in patch_files:
        with open(patch_file, 'r', encoding='utf-8') as f:
            first_line = f.readline().strip()
            # Extract title from markdown header
            title_match = re.match(r'#\s*Patch\s*\d+:\s*(.*)', first_line)
            if title_match:
                title = title_match.group(1)
                summary += f"- [{patch_file}: {title}]({patch_file})\n"

    with open('SCX-patch-study.md', 'w', encoding='utf-8') as f:
        f.write(summary)
    
    print("Generated SCX-patch-study.md")

if __name__ == "__main__":
    generate_summary()
