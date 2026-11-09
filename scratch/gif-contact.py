from PIL import Image, ImageDraw
im = Image.open('docs/media/aivin-mascot-live.gif')
thumbs = []
for i in range(im.n_frames):
    im.seek(i)
    f = im.convert('RGBA').copy()
    f.thumbnail((240, 216))
    thumbs.append((i, f.copy()))
out = Image.new('RGB', (720, ((len(thumbs)+2)//3)*250), '#eee')
d = ImageDraw.Draw(out)
for j, (i, f) in enumerate(thumbs):
    x, y = (j%3)*240, (j//3)*250
    out.paste(f, (x, y), f)
    d.text((x+4, y+218), str(i), fill='black')
out.save('scratch/gif-contact.png')
