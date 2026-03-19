import os
import re

def parse_patch(patch_content, filename):
    subject_match = re.search(r"^Subject: (.*)$", patch_content, re.MULTILINE)
    subject = subject_match.group(1).strip() if subject_match else "No Subject"

    patch_num_from_filename_match = re.search(r"patch-(\d+)\.eml", filename)
    if not patch_num_from_filename_match:
        print(f"Skipping file with unexpected name format: {filename}")
        return None
    
    patch_num = patch_num_from_filename_match.group(1)

    subject = re.sub(r"\[PATCH\s+v?\d*\s*\d+/\d+\]\s*", "", subject)
    subject = re.sub(r"\[PATCHSET\s+v?\d*\]\s*", "", subject)

    # Find the end of the headers
    header_end = patch_content.find("\n\n")
    if header_end == -1:
        # if no blank line, then maybe there are no headers
        header_end = 0

    # Find the start of the diff
    diff_start = patch_content.find("\n---")
    if diff_start == -1:
        diff_start = len(patch_content)

    # The commit message is between the end of the headers and the start of the diff
    commit_message = patch_content[header_end:diff_start].strip()

    # Clean up signature blocks from the commit message
    commit_message = re.sub(r"^\s*Signed-off-by:.*$", "", commit_message, flags=re.MULTILINE)
    commit_message = re.sub(r"^\s*Reviewed-by:.*$", "", commit_message, flags=re.MULTILINE)
    commit_message = re.sub(r"^\s*Acked-by:.*$", "", commit_message, flags=re.MULTILINE)
    commit_message = re.sub(r"^\s*Suggested-by:.*$", "", commit_message, flags=re.MULTILINE)
    commit_message = re.sub(r"^\s*Link:.*$", "", commit_message, flags=re.MULTILINE)
    commit_message = re.sub(r"^\s*v\d:.*$", "", commit_message, flags=re.MULTILINE)

    diff_match = re.search(r"^---.*", patch_content, re.MULTILINE | re.DOTALL)
    diff = diff_match.group(0) if diff_match else "No diff found."

    return {
        "patch_num": f"{int(patch_num):02d}",
        "subject": subject,
        "commit_message": commit_message.strip(),
        "diff": diff
    }

def create_markdown(patch_data):
    patch_num = patch_data["patch_num"]
    subject = patch_data["subject"]
    commit_message = patch_data["commit_message"]
    diff = patch_data["diff"]

    markdown = f"""# Patch {patch_num}: {subject}

## Commit Message

> {commit_message}

## Implementation Analysis

(This is a placeholder for the implementation analysis. I will fill this in later.)

## Diff

```diff
{diff}
```
"""
    return markdown

def main():
    if not os.path.exists("patches"):
        print("Error: 'patches' directory not found.")
        return

    # First, delete any existing markdown files to avoid confusion
    for filename in os.listdir("."):
        if filename.startswith("patch-") and filename.endswith(".md"):
            os.remove(filename)

    for filename in sorted(os.listdir("patches")):
        if filename.endswith(".eml"):
            filepath = os.path.join("patches", filename)
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
            
            patch_data = parse_patch(content, filename)
            if patch_data:
                markdown_content = create_markdown(patch_data)
                
                md_filename = f"patch-{patch_data['patch_num']}.md"
                with open(md_filename, 'w', encoding='utf-8') as f:
                    f.write(markdown_content)
                print(f"Created {md_filename}")

if __name__ == "__main__":
    main()
