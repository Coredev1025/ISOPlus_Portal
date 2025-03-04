"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Upload } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Header } from "@/components/ui/header";
import axios from "axios";
import { getCookie } from "@/app/utils/cookies";

const AUSTRALIAN_STATES = [
  { value: "act", label: "Australian Capital Territory" },
  { value: "nsw", label: "New South Wales" },
  { value: "nt", label: "Northern Territory" },
  { value: "qld", label: "Queensland" },
  { value: "sa", label: "South Australia" },
  { value: "tas", label: "Tasmania" },
  { value: "vic", label: "Victoria" },
  { value: "wa", label: "Western Australia" },
];

export default function ConfigureBusinessPage() {
  const router = useRouter();
  const pathname = usePathname();
  const id = pathname.split("/")[2];
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    phone: "",
    email: "",
    street1: "",
    street2: "",
    city: "",
    state: "",
    postcode: "",
    abn: "",
    acn: "",
    workspaceId: id,
  });
  const [showSuccess, setShowSuccess] = useState(false);
  const [showError, setShowError] = useState(false);

  useEffect(() => {
    // Fetch the saved business profile data when the page loads
    const fetchBusinessProfile = async () => {
      try {
        const response = await axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/profile`, { headers: { token: getCookie("token") }, params: { workspaceId: id } });
        const data = response.data;
        setFormData({
          name: data.name || "",
          phone: data.phone || "",
          email: data.email || "",
          street1: data.address?.street1 || "",
          street2: data.address?.street2 || "",
          city: data.address?.city || "",
          state: data.address?.state || "",
          postcode: data.address?.postcode || "",
          abn: data.abn || "",
          acn: data.acn || "",
          workspaceId: id
        });
        if (data.logo) {
          setLogoPreview(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business${data.logo}`);
        }
      } catch (error) {
        console.error("Failed to fetch business profile:", error);
      }
    };

    fetchBusinessProfile();
  }, []);

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setLogoFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setLogoPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { id, value } = e.target;
    setFormData((prevData) => ({
      ...prevData,
      [id]: value,
    }));
  };

  const handleSave = async () => {
    try {
      const formDataToSend = new FormData();
      Object.keys(formData).forEach((key) => {
        formDataToSend.append(key, formData[key as keyof typeof formData]);
      });
      if (logoFile) {
        formDataToSend.append("logo", logoFile);
      }

      const response = await axios.put(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/profile`, formDataToSend, {
        headers: {
          "Content-Type": "multipart/form-data",
          "token": getCookie("token")
        }
      });

      console.log("Business profile saved:", response.data);
      setShowError(false);
      setShowSuccess(true);
    } catch (error) {
      setShowSuccess(false);
      setShowError(true);
      console.error("Failed to save business profile:", error);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto py-8">
        <Button variant="ghost" className="mb-6" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Workspace
        </Button>

        <Card className="max-w-2xl mx-auto p-6">
          <h1 className="text-2xl font-bold mb-6">Configure Your Business</h1>

          {showSuccess && (
            <div className="mb-4 p-4 text-green-700 bg-green-100 rounded">
              Business profile saved successfully!
            </div>
          )}

          {showError && (
            <div className="mb-4 p-4 text-green-700 bg-green-100 rounded">
              Business profile saved failed, please input information correctly!
            </div>
          )}

          <div className="space-y-6">
            <div className="space-y-2">
              <Label>Company Logo</Label>
              <div className="flex items-center gap-4">
                <div className="w-32 h-32 border-2 border-dashed rounded-lg flex items-center justify-center bg-muted">
                  {logoPreview ? (
                    <img
                      src={logoPreview}
                      alt="Preview"
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <Upload className="h-8 w-8 text-muted-foreground" />
                  )}
                </div>
                <div>
                  <Input
                    type="file"
                    accept="image/*"
                    onChange={handleLogoChange}
                    className="max-w-xs"
                  />
                  <p className="text-sm text-muted-foreground mt-2">
                    Recommended size: 512x512px
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Company Name</Label>
                  <Input
                    id="name"
                    placeholder="Enter company name"
                    value={formData.name}
                    onChange={handleInputChange}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone Number</Label>
                  <Input
                    id="phone"
                    placeholder="Enter phone number"
                    value={formData.phone}
                    onChange={handleInputChange}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">Business Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="Enter business email"
                  value={formData.email}
                  onChange={handleInputChange}
                />
              </div>

              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Business Address</h3>
                <div className="space-y-2">
                  <Label htmlFor="street1">Street Address 1</Label>
                  <Input
                    id="street1"
                    placeholder="Enter street address"
                    value={formData.street1}
                    onChange={handleInputChange}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="street2">Street Address 2</Label>
                  <Input
                    id="street2"
                    placeholder="Enter additional address details (optional)"
                    value={formData.street2}
                    onChange={handleInputChange}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="city">City</Label>
                    <Input
                      id="city"
                      placeholder="Enter city"
                      value={formData.city}
                      onChange={handleInputChange}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="state">State</Label>
                    <Select
                      value={formData.state}
                      onValueChange={(value) =>
                        setFormData((prevData) => ({
                          ...prevData,
                          state: value,
                        }))
                      }
                    >
                      <SelectTrigger id="state">
                        <SelectValue placeholder="Select state" />
                      </SelectTrigger>
                      <SelectContent>
                        {AUSTRALIAN_STATES.map((state) => (
                          <SelectItem key={state.value} value={state.value}>
                            {state.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="postcode">Post Code</Label>
                  <Input
                    id="postcode"
                    placeholder="Enter post code"
                    maxLength={4}
                    value={formData.postcode}
                    onChange={handleInputChange}
                  />
                </div>
              </div>

              {/* Business Numbers */}
              <div className="grid grid-cols-1 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="abn">Australian Business Number (ABN)</Label>
                  <Input
                    id="abn"
                    placeholder="Enter ABN"
                    maxLength={11}
                    value={formData.abn}
                    onChange={handleInputChange}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="acn">Australian Company Number (ACN)</Label>
                  <Input
                    id="acn"
                    placeholder="Enter ACN"
                    maxLength={9}
                    value={formData.acn}
                    onChange={handleInputChange}
                  />
                </div>
              </div>
            </div>

            <Button className="w-full" size="lg" onClick={handleSave}>
              Save Business Configuration
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}