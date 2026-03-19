import mailbox
import os
import sys

def split_mbox(mbox_file):
    if not os.path.exists("patches"):
        os.makedirs("patches")

    mbox = mailbox.mbox(mbox_file)
    for i, msg in enumerate(mbox):
        with open(f"patches/patch-{i+1:02d}.eml", "w") as f:
            f.write(str(msg))

if __name__ == '__main__':
    if len(sys.argv) > 1:
        split_mbox(sys.argv[1])
    else:
        print("Usage: python split_mbox.py <mbox_file>")
